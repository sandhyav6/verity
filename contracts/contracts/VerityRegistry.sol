// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title VerityRegistry
/// @notice Tamper-evident registry of document fingerprints. Documents never touch the chain: only the
///         SHA-256 digest of the exact file bytes (as a `bytes32`), a few classification fields and a
///         hash of off-chain metadata are recorded.
/// @dev What this contract guarantees: *who* (an issuer address) registered *which fingerprint* and *when*,
///      and whether that issuer later revoked it. What it does NOT guarantee: that the document's claims
///      are true, or that the issuer is a legitimate real-world organisation (see `Issuer.name`; that is a
///      label chosen by an issuer manager, not proof of identity).
///
///      Role design (no single all-powerful account):
///        - `DEFAULT_ADMIN_ROLE` (two-step, time-delayed transfer): grants/revokes roles only.
///        - `ISSUER_MANAGER_ROLE`: authorises and removes issuers. Cannot register or revoke documents.
///        - Issuers: register documents and batches, and revoke *their own* records. Nobody else can.
///
///      Hash conventions (must match backend and frontend, see docs/hashing.md and test vectors):
///        - `documentHash` = SHA-256 of the raw file bytes, as 32 raw bytes (hex: 0x + 64 lowercase chars).
///        - Merkle leaf   = keccak256(0x00 || documentHash)          (domain-separated leaf)
///        - Merkle node   = keccak256(min(a,b) || max(a,b))          (sorted pair, OpenZeppelin MerkleProof)
contract VerityRegistry is AccessControlDefaultAdminRules {
    // ------------------------------------------------------------------------------------------ types

    bytes32 public constant ISSUER_MANAGER_ROLE = keccak256("ISSUER_MANAGER_ROLE");

    /// @notice Classification of a document. Fixed list so the value is validated by the ABI decoder.
    enum DocumentType {
        Other,
        AcademicCertificate,
        InternshipCertificate,
        ResearchPublication,
        ComplianceDocument,
        AuditReport,
        LegalAgreement,
        SoftwareRelease,
        OfficialReport
    }

    /// @notice Result of a verification lookup. Ordered by precedence: a revoked record is `Revoked`
    ///         even if it has also expired.
    enum Status {
        NotRegistered,
        Valid,
        Revoked,
        Expired
    }

    struct Issuer {
        bool authorized;
        uint64 authorizedAt;
        uint64 removedAt;
        string name;
    }

    struct Record {
        address issuer;
        uint64 registeredAt; // 0 = not registered
        uint64 revokedAt; // 0 = not revoked
        uint64 expiresAt; // 0 = does not expire
        uint32 version;
        DocumentType docType;
        address revokedBy;
        bytes32 documentId;
        bytes32 metadataHash;
        bytes32 reasonHash;
    }

    struct Verification {
        Status status;
        address issuer;
        bool issuerAuthorized; // is the issuer authorised *now* (registration stays valid after removal)
        bytes32 documentId;
        uint32 version;
        uint32 latestVersion; // newest registered version of `documentId`; version < latestVersion = superseded
        DocumentType docType;
        bytes32 metadataHash;
        uint64 registeredAt;
        uint64 expiresAt;
        uint64 revokedAt;
        address revokedBy;
        bytes32 reasonHash;
    }

    struct Batch {
        address issuer;
        uint64 registeredAt;
        uint64 revokedAt;
        uint32 documentCount;
        bytes32 merkleRoot;
        bytes32 metadataHash;
    }

    struct BatchVerification {
        bool included; // the proof links the document to the batch root
        Status status; // Valid | Revoked (batch-level or document-level) | NotRegistered when not included
        address issuer;
        bool issuerAuthorized;
        uint64 registeredAt;
        uint64 revokedAt; // earliest applicable revocation (document or whole batch)
        bytes32 merkleRoot;
    }

    uint256 private constant MAX_NAME_BYTES = 100;

    // ----------------------------------------------------------------------------------------- storage

    mapping(address => Issuer) private _issuers;
    mapping(bytes32 documentHash => Record) private _records;
    /// @notice The issuer that first registered a `documentId`; only they can add versions to it.
    mapping(bytes32 documentId => address) public documentOwner;
    mapping(bytes32 documentId => uint32) public latestVersion;
    /// @notice Fingerprint registered as `version` of `documentId` (0x0 if none).
    mapping(bytes32 documentId => mapping(uint32 version => bytes32)) public versionHash;

    uint256 public batchCount;
    mapping(uint256 batchId => Batch) private _batches;
    mapping(bytes32 merkleRoot => uint256) public batchIdByRoot;
    mapping(uint256 batchId => mapping(bytes32 documentHash => uint64)) private _batchDocRevokedAt;

    // ------------------------------------------------------------------------------------------ events

    event IssuerAuthorized(address indexed issuer, address indexed authorizedBy, string name);
    event IssuerRemoved(address indexed issuer, address indexed removedBy);

    event DocumentRegistered(
        bytes32 indexed documentHash,
        bytes32 indexed documentId,
        address indexed issuer,
        uint32 version,
        DocumentType docType,
        bytes32 metadataHash,
        uint64 expiresAt
    );
    event DocumentRevoked(
        bytes32 indexed documentHash, bytes32 indexed documentId, address indexed revokedBy, bytes32 reasonHash
    );

    event BatchRegistered(
        uint256 indexed batchId,
        bytes32 indexed merkleRoot,
        address indexed issuer,
        uint32 documentCount,
        bytes32 metadataHash
    );
    event BatchRevoked(uint256 indexed batchId, address indexed revokedBy, bytes32 reasonHash);
    event BatchDocumentRevoked(
        uint256 indexed batchId, bytes32 indexed documentHash, address indexed revokedBy, bytes32 reasonHash
    );

    // ------------------------------------------------------------------------------------------ errors

    error NotAuthorizedIssuer(address account);
    error IssuerAlreadyAuthorized(address issuer);
    error IssuerNotAuthorized(address issuer);
    error InvalidAddress();
    error InvalidName();
    error InvalidHash();
    error InvalidDocumentId();
    error InvalidExpiry(uint64 expiresAt);
    error AlreadyRegistered(bytes32 documentHash);
    error NotRegistered(bytes32 documentHash);
    error NotDocumentOwner(bytes32 documentId, address caller);
    error NotRecordIssuer(address caller);
    error AlreadyRevoked();
    error InvalidBatch();
    error BatchRootAlreadyRegistered(bytes32 merkleRoot);
    error BatchNotFound(uint256 batchId);
    error InvalidProof();

    // ---------------------------------------------------------------------------------------- modifiers

    modifier onlyIssuer() {
        if (!_issuers[msg.sender].authorized) revert NotAuthorizedIssuer(msg.sender);
        _;
    }

    /// @param admin Receives `DEFAULT_ADMIN_ROLE` and `ISSUER_MANAGER_ROLE`.
    /// @param adminTransferDelay Seconds between proposing and accepting a change of default admin.
    constructor(address admin, uint48 adminTransferDelay) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        _grantRole(ISSUER_MANAGER_ROLE, admin);
    }

    // ------------------------------------------------------------------------------- issuer management

    /// @notice Authorise `issuer` to register documents. `name` is a display label (e.g. the organisation).
    function authorizeIssuer(address issuer, string calldata name) external onlyRole(ISSUER_MANAGER_ROLE) {
        if (issuer == address(0)) revert InvalidAddress();
        uint256 len = bytes(name).length;
        if (len == 0 || len > MAX_NAME_BYTES) revert InvalidName();
        Issuer storage i = _issuers[issuer];
        if (i.authorized) revert IssuerAlreadyAuthorized(issuer);
        i.authorized = true;
        i.authorizedAt = uint64(block.timestamp);
        i.removedAt = 0;
        i.name = name;
        emit IssuerAuthorized(issuer, msg.sender, name);
    }

    /// @notice Withdraw authorisation. Existing registrations stay on record and stay verifiable; the issuer
    ///         can still revoke them but cannot register anything new until re-authorised.
    function removeIssuer(address issuer) external onlyRole(ISSUER_MANAGER_ROLE) {
        Issuer storage i = _issuers[issuer];
        if (!i.authorized) revert IssuerNotAuthorized(issuer);
        i.authorized = false;
        i.removedAt = uint64(block.timestamp);
        emit IssuerRemoved(issuer, msg.sender);
    }

    function isAuthorizedIssuer(address account) external view returns (bool) {
        return _issuers[account].authorized;
    }

    function getIssuer(address account) external view returns (Issuer memory) {
        return _issuers[account];
    }

    // ------------------------------------------------------------------------------ document lifecycle

    /// @notice Register one version of a document. The first registration of `documentId` creates version 1;
    ///         each later call by the same issuer creates the next version as a *new* record. Earlier
    ///         versions remain independently verifiable and are not touched.
    /// @param documentId Stable identifier that groups the versions of one logical document.
    /// @param documentHash SHA-256 of the file bytes. Must not have been registered before (by anyone).
    /// @param docType Document classification.
    /// @param metadataHash SHA-256 of the canonical off-chain metadata (title, description, ...); 0x0 if none.
    /// @param expiresAt Unix time after which the record reports `Expired`; 0 = never.
    function registerDocument(
        bytes32 documentId,
        bytes32 documentHash,
        DocumentType docType,
        bytes32 metadataHash,
        uint64 expiresAt
    ) external onlyIssuer returns (uint32 version) {
        if (documentId == bytes32(0)) revert InvalidDocumentId();
        if (documentHash == bytes32(0)) revert InvalidHash();
        if (_records[documentHash].registeredAt != 0) revert AlreadyRegistered(documentHash);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt);

        address owner = documentOwner[documentId];
        if (owner == address(0)) {
            documentOwner[documentId] = msg.sender;
        } else if (owner != msg.sender) {
            revert NotDocumentOwner(documentId, msg.sender);
        }

        version = latestVersion[documentId] + 1;
        latestVersion[documentId] = version;
        versionHash[documentId][version] = documentHash;
        _records[documentHash] = Record({
            issuer: msg.sender,
            registeredAt: uint64(block.timestamp),
            revokedAt: 0,
            expiresAt: expiresAt,
            version: version,
            docType: docType,
            revokedBy: address(0),
            documentId: documentId,
            metadataHash: metadataHash,
            reasonHash: bytes32(0)
        });
        emit DocumentRegistered(documentHash, documentId, msg.sender, version, docType, metadataHash, expiresAt);
    }

    /// @notice Permanently revoke one registered version. The record is kept (never deleted) and gains a
    ///         revocation timestamp, revoker and reason hash. Other versions are NOT affected.
    /// @dev Only the issuer that registered the record may revoke it. This deliberately does not require the
    ///      issuer to still be authorised: revoking is a safety action and must stay possible after removal.
    function revokeDocument(bytes32 documentHash, bytes32 reasonHash) external {
        Record storage r = _records[documentHash];
        if (r.registeredAt == 0) revert NotRegistered(documentHash);
        if (r.issuer != msg.sender) revert NotRecordIssuer(msg.sender);
        if (r.revokedAt != 0) revert AlreadyRevoked();
        r.revokedAt = uint64(block.timestamp);
        r.revokedBy = msg.sender;
        r.reasonHash = reasonHash;
        emit DocumentRevoked(documentHash, r.documentId, msg.sender, reasonHash);
    }

    /// @notice Deterministic verification of a fingerprint against the registry.
    function verifyDocument(bytes32 documentHash) external view returns (Verification memory v) {
        Record storage r = _records[documentHash];
        if (r.registeredAt == 0) return v; // Status.NotRegistered, everything zero
        v.status = r.revokedAt != 0
            ? Status.Revoked
            : (r.expiresAt != 0 && r.expiresAt <= block.timestamp ? Status.Expired : Status.Valid);
        v.issuer = r.issuer;
        v.issuerAuthorized = _issuers[r.issuer].authorized;
        v.documentId = r.documentId;
        v.version = r.version;
        v.latestVersion = latestVersion[r.documentId];
        v.docType = r.docType;
        v.metadataHash = r.metadataHash;
        v.registeredAt = r.registeredAt;
        v.expiresAt = r.expiresAt;
        v.revokedAt = r.revokedAt;
        v.revokedBy = r.revokedBy;
        v.reasonHash = r.reasonHash;
    }

    // ------------------------------------------------------------------------------------------ batches

    /// @notice Register the Merkle root of a batch of document fingerprints in one transaction.
    ///         Individual documents are proven against the root with `verifyBatchDocument`.
    function registerBatch(bytes32 merkleRoot, uint32 documentCount, bytes32 metadataHash)
        external
        onlyIssuer
        returns (uint256 batchId)
    {
        if (merkleRoot == bytes32(0) || documentCount == 0) revert InvalidBatch();
        if (batchIdByRoot[merkleRoot] != 0) revert BatchRootAlreadyRegistered(merkleRoot);
        batchId = ++batchCount;
        batchIdByRoot[merkleRoot] = batchId;
        _batches[batchId] = Batch({
            issuer: msg.sender,
            registeredAt: uint64(block.timestamp),
            revokedAt: 0,
            documentCount: documentCount,
            merkleRoot: merkleRoot,
            metadataHash: metadataHash
        });
        emit BatchRegistered(batchId, merkleRoot, msg.sender, documentCount, metadataHash);
    }

    /// @notice Revoke every document in a batch.
    function revokeBatch(uint256 batchId, bytes32 reasonHash) external {
        Batch storage b = _batch(batchId);
        if (b.issuer != msg.sender) revert NotRecordIssuer(msg.sender);
        if (b.revokedAt != 0) revert AlreadyRevoked();
        b.revokedAt = uint64(block.timestamp);
        emit BatchRevoked(batchId, msg.sender, reasonHash);
    }

    /// @notice Revoke a single document of a batch. The caller proves membership with a Merkle proof.
    function revokeBatchDocument(uint256 batchId, bytes32 documentHash, bytes32[] calldata proof, bytes32 reasonHash)
        external
    {
        Batch storage b = _batch(batchId);
        if (b.issuer != msg.sender) revert NotRecordIssuer(msg.sender);
        if (!MerkleProof.verifyCalldata(proof, b.merkleRoot, leafOf(documentHash))) revert InvalidProof();
        if (_batchDocRevokedAt[batchId][documentHash] != 0) revert AlreadyRevoked();
        _batchDocRevokedAt[batchId][documentHash] = uint64(block.timestamp);
        emit BatchDocumentRevoked(batchId, documentHash, msg.sender, reasonHash);
    }

    /// @notice Check that `documentHash` is part of batch `batchId` (via `proof`) and whether it is revoked.
    function verifyBatchDocument(uint256 batchId, bytes32 documentHash, bytes32[] calldata proof)
        external
        view
        returns (BatchVerification memory v)
    {
        Batch storage b = _batches[batchId];
        if (b.registeredAt == 0) return v;
        if (!MerkleProof.verifyCalldata(proof, b.merkleRoot, leafOf(documentHash))) return v;
        uint64 docRevoked = _batchDocRevokedAt[batchId][documentHash];
        uint64 revoked = b.revokedAt;
        if (docRevoked != 0 && (revoked == 0 || docRevoked < revoked)) revoked = docRevoked;
        v.included = true;
        v.status = revoked != 0 ? Status.Revoked : Status.Valid;
        v.issuer = b.issuer;
        v.issuerAuthorized = _issuers[b.issuer].authorized;
        v.registeredAt = b.registeredAt;
        v.revokedAt = revoked;
        v.merkleRoot = b.merkleRoot;
    }

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return _batch(batchId);
    }

    /// @notice Merkle leaf for a document fingerprint: keccak256(0x00 || documentHash).
    ///         The 0x00 prefix domain-separates leaves from inner nodes (which hash 64 bytes).
    function leafOf(bytes32 documentHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), documentHash));
    }

    function _batch(uint256 batchId) private view returns (Batch storage b) {
        b = _batches[batchId];
        if (b.registeredAt == 0) revert BatchNotFound(batchId);
    }
}

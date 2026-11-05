# Local test chain (Hardhat node) and one-shot deployer. TEST NETWORKS ONLY.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY hardhat.config.ts tsconfig.json ./
COPY contracts ./contracts
COPY scripts ./scripts
# compile once at build time so the compiler download is cached in the image
RUN npx hardhat compile

EXPOSE 8545
CMD ["npx", "hardhat", "node", "--hostname", "0.0.0.0", "--port", "8545"]

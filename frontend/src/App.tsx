import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { EmptyState } from "./components/ui/feedback";
import { ButtonLink } from "./components/ui/primitives";
import { Activity } from "./pages/Activity";
import { BatchDetail, Batches } from "./pages/Batches";
import { BatchNew } from "./pages/BatchNew";
import { Dashboard } from "./pages/Dashboard";
import { DocumentDetails } from "./pages/DocumentDetails";
import { Issuers } from "./pages/Issuers";
import { Landing } from "./pages/Landing";
import { Register } from "./pages/Register";
import { Verify } from "./pages/Verify";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="verify" element={<Verify />} />
        <Route path="documents/:hash" element={<DocumentDetails />} />
        <Route path="issuers" element={<Issuers />} />
        <Route path="activity" element={<Activity />} />
        <Route path="app" element={<Dashboard />} />
        <Route path="app/register" element={<Register />} />
        <Route path="app/batches" element={<Batches />} />
        <Route path="app/batches/new" element={<BatchNew />} />
        <Route path="app/batches/:id" element={<BatchDetail />} />
        <Route path="*" element={<EmptyState title="Page not found" action={<ButtonLink to="/">Back to the homepage</ButtonLink>}>That address does not exist.</EmptyState>} />
      </Route>
    </Routes>
  );
}

import { Navigate, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { Session } from "./pages/Session";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/s/:sessionToken" element={<Session />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

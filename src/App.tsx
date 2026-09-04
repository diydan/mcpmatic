import { Navigate, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { Session } from "./pages/Session";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      {/*
        Two views of one session. The façade is what an agent loads and where
        registerAll() runs; the console is what a human opens, and the only
        place that can answer an approval. Same origin, so the profile in
        localStorage is reachable from both without moving.
      */}
      <Route path="/s/:sessionToken" element={<Session role="facade" />} />
      <Route path="/c/:sessionToken" element={<Session role="console" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

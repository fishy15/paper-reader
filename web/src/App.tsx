import { NavLink, Navigate, Route, Routes } from "react-router";
import { Library } from "./pages/Library.js";
import { Search } from "./pages/Search.js";

export function App() {
  return (
    <>
      <header className="topbar">
        <h1>Paper Reader</h1>
        <nav>
          <NavLink to="/search">Search</NavLink>
          <NavLink to="/library">Library</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/search" replace />} />
          <Route path="/search" element={<Search />} />
          <Route path="/library" element={<Library />} />
        </Routes>
      </main>
    </>
  );
}

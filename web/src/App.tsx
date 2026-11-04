import { Link, NavLink, Navigate, Route, Routes } from "react-router";
import { Library } from "./pages/Library.js";
import { PaperPage } from "./pages/Paper.js";
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
          <Route path="/papers/:id" element={<PaperPage />} />
          <Route
            path="*"
            element={
              <section>
                <h2>Page not found</h2>
                <p>
                  <Link to="/search">Search</Link>
                </p>
              </section>
            }
          />
        </Routes>
      </main>
    </>
  );
}

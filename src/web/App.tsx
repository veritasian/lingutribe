import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { useEffect, useState, type ReactNode, Fragment } from "react";
import Resources from "./pages/Resources";
import Words from "./pages/Words";
import Chat from "./pages/Chat";
import Read from "./pages/Read";
import Settings from "./pages/Settings";
import Notes from "./pages/Notes";
import {
  IconAudio,
  IconVideo,
  IconRead,
  IconWords,
  IconChat,
  IconSettings,
  IconNotes,
  IconPanelLeft,
  IconShieldCheck,
} from "./components/Icon";
import { t } from "./lib/locale";

type NavItem = { to: string; label: string; icon: ReactNode };
const NAV_ITEMS: { to: string; key: string; icon: ReactNode }[] = [
  { to: "/resources/audio", key: "audio", icon: <IconAudio size={18} /> },
  { to: "/resources/video", key: "video", icon: <IconVideo size={18} /> },
  { to: "/read", key: "read", icon: <IconRead size={18} /> },
  { to: "/words", key: "words", icon: <IconWords size={18} /> },
  { to: "/notes", key: "notes", icon: <IconNotes size={18} /> },
  { to: "/chat", key: "chat", icon: <IconChat size={18} /> },
  { to: "/settings", key: "settings", icon: <IconSettings size={18} /> },
];

export function applyTheme(theme: string) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("lingo-sidebar") !== "collapsed"
  );

  function toggleSidebar() {
    setSidebarOpen((v) => {
      const next = !v;
      localStorage.setItem("lingo-sidebar", next ? "open" : "collapsed");
      return next;
    });
  }

  // Theme: persisted in localStorage, reacts to Settings changes + OS switch.
  useEffect(() => {
    const t = localStorage.getItem("lingo-theme") || "light";
    applyTheme(t);
    const onTheme = () => applyTheme(localStorage.getItem("lingo-theme") || "light");
    const onSys = () => {
      if ((localStorage.getItem("lingo-theme") || "light") === "system") applyTheme("system");
    };
    window.addEventListener("lingo-theme-change", onTheme);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onSys);
    return () => {
      window.removeEventListener("lingo-theme-change", onTheme);
      window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", onSys);
    };
  }, []);

  return (
    <div className="flex h-full">
      {/* Left sidebar — collapsible to an icon rail */}
      <aside
        className="flex flex-col border-r bg-sidebar shrink-0"
        style={{ width: sidebarOpen ? 220 : 64, transition: "width 0.15s" }}
      >
        <div className="flex items-center justify-between px-4 h-14 border-b">
          {sidebarOpen && (
            <div className="text-[15px] font-semibold tracking-tight">
            Lingutribe
            <div className="text-[11px] font-normal text-muted-foreground">
                Local Language Studio
              </div>
            </div>
          )}
          <button
            className="toggle-circle-btn"
            onClick={toggleSidebar}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <IconPanelLeft size={18} />
          </button>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {NAV_ITEMS.map((n, i) => {
            const label = t(n.key as any);
            const isResources = i < 3;
            return (
              <Fragment key={n.to}>
                {sidebarOpen && i === 0 && (
                  <div className="px-2 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Resources
                  </div>
                )}
                <NavLink
                  to={n.to}
                  title={sidebarOpen ? undefined : label}
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                >
                  <span>{n.icon}</span>
                  {sidebarOpen && <span>{label}</span>}
                </NavLink>
              </Fragment>
            );
          })}
        </nav>
        <div className="mt-auto px-4 py-3 text-[10px] text-muted-foreground">
          {sidebarOpen ? (
            <span className="inline-flex items-center gap-1">
              <IconShieldCheck size={14} /> 100% local · no cloud
            </span>
          ) : (
            <IconShieldCheck size={16} />
          )}
        </div>
      </aside>

      {/* Right content */}
      <main className="flex-1 min-w-0 flex flex-col">
        <Routes>
          <Route path="/" element={<Navigate to="/resources/audio" replace />} />
          <Route path="/resources" element={<Navigate to="/resources/audio" replace />} />
          <Route path="/resources/:tab" element={<Resources />} />
          <Route path="/read" element={<Read />} />
          <Route path="/words" element={<Words />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}

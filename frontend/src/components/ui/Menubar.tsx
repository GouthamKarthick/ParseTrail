/**
 * @fileoverview Menubar — top navigation with hamburger sidebar for mobile and profile dropdown.
 */

import { useCallback, useState, useEffect, useRef } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import styles from "./Menubar.module.scss";
import { Avatar } from "../Avatar";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";

/**
 * Application menubar rendered on every route.
 * Mobile: hamburger → sidebar (Upload/Documents/Dashboard) before logo, centered Upload card.
 * Profile dropdown at right contains email, theme toggle and logout.
 * @returns Header with navigation and user actions
 */
export function Menubar() {
  const { user, avatar, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const verifiedUser = user?.email_verified ? user : null;
  const isVerified = verifiedUser !== null;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const handleLogout = useCallback(async () => {
    await logout();
    setProfileOpen(false);
    nav("/login");
  }, [logout, nav]);

  // Close profile dropdown on outside click / route change
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (
        profileRef.current &&
        !profileRef.current.contains(e.target as Node)
      ) {
        setProfileOpen(false);
      }
    }
    if (profileOpen) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [profileOpen]);

  // Close sidebar on navigation
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <header className={styles.menubar} role="banner">
      <div className={styles["menubar-inner"]}>
        {/* Hamburger — visible only on mobile, before logo */}
        {isVerified && (
          <button
            className={styles["menubar-hamburger"]}
            aria-label={sidebarOpen ? "Close menu" : "Open menu"}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <i className="bi bi-list" aria-hidden />
          </button>
        )}

        <NavLink
          to="/"
          className={styles["menubar-brand"]}
          aria-label="ClarityDocs home"
          onClick={closeSidebar}
        >
          <span className={styles["menubar-logo"]} aria-hidden>
            <svg
              width="32"
              height="32"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="32" height="32" rx="9" fill="url(#logoGrad)" />
              <g filter="url(#logoShadow)">
                <path d="M10 9.5H19L22.5 13V23.5H10V9.5Z" fill="white" />
                <path
                  d="M19 9.5V13H22.5"
                  fill="#f1f5f9"
                  stroke="#cbd5e1"
                  strokeWidth="0.9"
                />
                <rect
                  x="12.2"
                  y="15"
                  width="7.5"
                  height="1.3"
                  rx="0.65"
                  fill="#2563eb"
                />
                <rect
                  x="12.2"
                  y="17.4"
                  width="7.5"
                  height="1.3"
                  rx="0.65"
                  fill="#94a3b8"
                />
                <rect
                  x="12.2"
                  y="19.8"
                  width="5.2"
                  height="1.3"
                  rx="0.65"
                  fill="#e2e8f0"
                />
              </g>
              <g>
                <circle
                  cx="19.8"
                  cy="17.2"
                  r="3.4"
                  fill="#0ea5e9"
                  stroke="white"
                  strokeWidth="1.6"
                />
                <circle
                  cx="19.8"
                  cy="17.2"
                  r="1.7"
                  fill="none"
                  stroke="white"
                  strokeWidth="0.9"
                  opacity="0.9"
                />
                <path
                  d="M22.1 19.5L24.2 21.6"
                  stroke="white"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </g>
              <defs>
                <linearGradient
                  id="logoGrad"
                  x1="4"
                  y1="4"
                  x2="28"
                  y2="28"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#2563eb" />
                  <stop offset="1" stopColor="#06b6d4" />
                </linearGradient>
                <filter
                  id="logoShadow"
                  x="8"
                  y="7.5"
                  width="16.5"
                  height="18"
                  filterUnits="userSpaceOnUse"
                  colorInterpolationFilters="sRGB"
                >
                  <feDropShadow
                    dx="0"
                    dy="1"
                    stdDeviation="1"
                    floodColor="#0f172a"
                    floodOpacity="0.12"
                  />
                </filter>
              </defs>
            </svg>
          </span>
          <span className={styles["menubar-title"]}>
            Clarity<span className={styles["menubar-title-accent"]}>Docs</span>
          </span>
        </NavLink>

        {/* Desktop nav — hidden on mobile */}
        {isVerified && (
          <nav className={styles["menubar-nav"]} aria-label="Primary">
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive ? styles["menubar-active"] : styles["menubar-link"]
              }
            >
              <i className="bi bi-cloud-arrow-up-fill" aria-hidden /> Upload
            </NavLink>
            <NavLink
              to="/documents"
              className={({ isActive }) =>
                isActive ? styles["menubar-active"] : styles["menubar-link"]
              }
            >
              <i className="bi bi-file-earmark-text-fill" aria-hidden /> Documents
            </NavLink>
            <NavLink
              to="/dashboard"
              className={({ isActive }) =>
                isActive ? styles["menubar-active"] : styles["menubar-link"]
              }
            >
              <i className="bi bi-bar-chart-fill" aria-hidden /> Dashboard
            </NavLink>
          </nav>
        )}

        {/* Right corner — profile dropdown */}
        <div className={styles["menubar-right"]} ref={profileRef}>
          {verifiedUser ? (
            <div className={styles["menubar-profile-wrap"]}>
              <button
                className={styles["menubar-profile"]}
                onClick={() => setProfileOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
              >
                <Avatar
                  first_name={verifiedUser.first_name}
                  last_name={verifiedUser.last_name}
                  email={verifiedUser.email}
                  src={avatar}
                  size={24}
                />{" "}
                <span className={styles["menubar-profile-email"]}>
                  {verifiedUser.first_name} {verifiedUser.last_name}
                </span>{" "}
                <i
                  className="bi bi-chevron-down"
                  aria-hidden
                  style={{ fontSize: "0.75em" }}
                />
              </button>
              {profileOpen && (
                <div className={styles["menubar-profile-dropdown"]} role="menu">
                  <div className={styles["menubar-profile-header"]}>
                    <Avatar
                      first_name={verifiedUser.first_name}
                      last_name={verifiedUser.last_name}
                      email={verifiedUser.email}
                      src={avatar}
                      size={28}
                    />{" "}
                    {verifiedUser.email}
                  </div>
                  <button
                    className={styles["menubar-profile-item"]}
                    onClick={() => {
                      setProfileOpen(false);
                      nav("/profile");
                    }}
                    role="menuitem"
                  >
                    <i className="bi bi-person-fill" aria-hidden /> View profile
                  </button>
                  <button
                    className={styles["menubar-profile-item"]}
                    onClick={() => {
                      toggle();
                      setProfileOpen(false);
                    }}
                    role="menuitem"
                  >
                    <i
                      className={
                        theme === "dark"
                          ? "bi bi-brightness-high-fill"
                          : "bi bi-moon-stars-fill"
                      }
                      aria-hidden
                    />{" "}
                    {theme === "dark" ? "Light mode" : "Dark mode"}
                  </button>
                  <button
                    className={styles["menubar-profile-item--danger"]}
                    onClick={handleLogout}
                    role="menuitem"
                  >
                    <i
                      className={`bi bi-box-arrow-right ${styles["menubar-strong-icon"]}`}
                      aria-hidden
                    />{" "}
                    Logout
                  </button>
                </div>
              )}
            </div>
          ) : user ? (
            <NavLink
              to="/verify-email"
              className={styles["menubar-link"]}
            >
              Verify email
            </NavLink>
          ) : null}
        </div>
      </div>

      {/* Mobile sidebar overlay */}
      {isVerified && sidebarOpen && (
        <div
          className={styles["menubar-backdrop"]}
          onClick={closeSidebar}
          aria-hidden
        />
      )}

      {/* Mobile sidebar — Upload/Documents/Dashboard */}
      {isVerified && (
        <nav
          className={`${styles["menubar-sidebar"]} ${sidebarOpen ? styles["menubar-sidebar--open"] : ""}`}
          aria-label="Mobile"
        >
          <div className={styles["menubar-sidebar-header"]}>
            <span className={styles["menubar-sidebar-title"]}>Menu</span>
            <button
              className={styles["menubar-sidebar-close"]}
              onClick={closeSidebar}
              aria-label="Close menu"
            >
              <i className="bi bi-x-lg" aria-hidden />
            </button>
          </div>
          <NavLink
            to="/"
            className={({ isActive }) =>
              isActive
                ? styles["menubar-sidebar-link--active"]
                : styles["menubar-sidebar-link"]
            }
            onClick={closeSidebar}
          >
            <i className="bi bi-cloud-arrow-up-fill" aria-hidden /> Upload
          </NavLink>
          <NavLink
            to="/documents"
            className={({ isActive }) =>
              isActive
                ? styles["menubar-sidebar-link--active"]
                : styles["menubar-sidebar-link"]
            }
            onClick={closeSidebar}
          >
            <i className="bi bi-file-earmark-text-fill" aria-hidden /> Documents
          </NavLink>
          <NavLink
            to="/dashboard"
            className={({ isActive }) =>
              isActive
                ? styles["menubar-sidebar-link--active"]
                : styles["menubar-sidebar-link"]
            }
            onClick={closeSidebar}
          >
            <i className="bi bi-bar-chart-fill" aria-hidden /> Dashboard
          </NavLink>
        </nav>
      )}
    </header>
  );
}

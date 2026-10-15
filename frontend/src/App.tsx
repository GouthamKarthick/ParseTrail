/**
 * @fileoverview App root — lazy page imports, auth/theme providers, and route guards.
 */

import { lazy, Suspense } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { ToastProvider } from "./context/ToastContext";
import { Menubar } from "./components/ui/Menubar";
import { PageSkeleton } from "./components/Skeleton";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";

// ---------------------------------------------------------------------------
// Lazy Pages
// ---------------------------------------------------------------------------

const Upload = lazy(() => import("./pages/Upload"));
const List = lazy(() => import("./pages/List"));
const Detail = lazy(() => import("./pages/Detail"));
const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail"));
const SetupProfile = lazy(() => import("./pages/SetupProfile"));
const Profile = lazy(() => import("./pages/Profile"));

// ---------------------------------------------------------------------------
// Route Guards
// ---------------------------------------------------------------------------

/**
 * Guard for guest-only routes; redirects authenticated users to home.
 * @param props.children - Guest content
 * @returns Children or redirect
 * @example <GuestOnly><Login /></GuestOnly>
 */
function GuestOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function VerifiedOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageSkeleton />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.email_verified) return <Navigate to="/verify-email" replace />;
  return <>{children}</>;
}

/**
 * Routes remounted per pathname so the route-fade animation replays.
 * @returns Routes with transition wrapper
 * @example <AnimatedRoutes />
 */
function AnimatedRoutes() {
  const location = useLocation();
  return (
    <div key={location.pathname} className="route-fade">
      <Routes>
        <Route
          path="/login"
          element={
            <GuestOnly>
              <Login />
            </GuestOnly>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <Register />
            </GuestOnly>
          }
        />
        <Route
          path="/forgot-password"
          element={
            <GuestOnly>
              <ForgotPassword />
            </GuestOnly>
          }
        />
        <Route
          path="/reset-password"
          element={
            <GuestOnly>
              <ResetPassword />
            </GuestOnly>
          }
        />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route
          path="/setup-profile"
          element={
            <VerifiedOnly>
              <SetupProfile />
            </VerifiedOnly>
          }
        />
        <Route
          path="/profile"
          element={
            <VerifiedOnly>
              <Profile />
            </VerifiedOnly>
          }
        />
        <Route
          path="/"
          element={
            <VerifiedOnly>
              <Upload />
            </VerifiedOnly>
          }
        />
        <Route
          path="/documents"
          element={
            <VerifiedOnly>
              <List />
            </VerifiedOnly>
          }
        />
        <Route
          path="/documents/:id"
          element={
            <VerifiedOnly>
              <Detail />
            </VerifiedOnly>
          }
        />
        <Route
          path="/dashboard"
          element={
            <VerifiedOnly>
              <Dashboard />
            </VerifiedOnly>
          }
        />
      </Routes>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root Component
// ---------------------------------------------------------------------------

/**
 * Root application component wiring providers and routing.
 * @returns App element with all routes
 * @example <App />
 */
export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Menubar />
            <Suspense fallback={<PageSkeleton />}>
              <AnimatedRoutes />
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

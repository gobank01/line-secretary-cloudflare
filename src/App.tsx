import { useCallback, useEffect, useState } from "react";
import { getSession } from "./api";
import Dashboard from "./components/Dashboard";
import Login from "./components/Login";

type AuthState = "checking" | "authenticated" | "unauthenticated";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("checking");
  const authenticate = useCallback(() => setAuth("authenticated"), []);
  const unauthenticate = useCallback(() => setAuth("unauthenticated"), []);

  useEffect(() => {
    let active = true;
    void getSession()
      .then(() => {
        if (active) authenticate();
      })
      .catch(() => {
        if (active) unauthenticate();
      });
    return () => {
      active = false;
    };
  }, [authenticate, unauthenticate]);

  if (auth === "checking") {
    return (
      <main className="session-loading" role="status" aria-label="กำลังตรวจสอบสิทธิ์">
        <div className="brand-mark brand-mark--large" aria-hidden="true" />
        <span>กำลังเปิดพื้นที่ส่วนตัว…</span>
      </main>
    );
  }
  return auth === "authenticated" ? (
    <Dashboard onUnauthorized={unauthenticate} />
  ) : (
    <Login onAuthenticated={authenticate} />
  );
}

import { useState, type FormEvent } from "react";
import { ApiError, login } from "../api";

interface LoginProps {
  onAuthenticated(): void;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      onAuthenticated();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? "ลองรหัสผ่านหลายครั้งเกินไป กรุณารอ 15 นาที"
          : "รหัสผ่านไม่ถูกต้อง กรุณาลองอีกครั้ง",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <svg viewBox="0 0 32 32" role="presentation">
            <path d="M7 7h18v13H14l-5 5v-5H7z" />
            <path d="M11 12h10M11 16h7" />
          </svg>
        </div>
        <p className="eyebrow">OWNER CONSOLE</p>
        <h1 id="login-title">เลขากลุ่ม</h1>
        <p className="login-intro">สรุปสิ่งสำคัญจากทุกกลุ่ม โดยไม่รบกวนบทสนทนา</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="owner-password">รหัสผ่าน</label>
          <input
            id="owner-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={submitting}
          />
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="button button--primary" type="submit" disabled={!password || submitting}>
            {submitting ? "กำลังตรวจสอบ…" : "เข้าสู่ระบบ"}
          </button>
        </form>
        <p className="login-footnote">ข้อมูลอยู่บน Cloudflare และเข้าถึงได้เฉพาะเจ้าของ</p>
      </section>
    </main>
  );
}

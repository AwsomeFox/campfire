/** Password recovery is deliberately one task at a time: request, then redeem. */
import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, API } from "../../lib/api";
import { PasswordInput } from "../../components/PasswordInput";
import { Card } from "../../components/ui";
import {
  AUTH_ERROR_IDS,
  AUTH_FIELD_IDS,
  AUTH_GENERIC_ERROR,
  AUTH_RATE_LIMIT_ERROR,
  AUTH_RESET_CODE_ERROR,
  type AuthErrorState,
  describedBy,
  focusAuthError,
} from "./authFormA11y";
import {
  resetStepForCode,
  validateResetPassword,
  type ResetStep,
} from "./resetPasswordFlow";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const initialCode = searchParams.get("code") ?? "";
  const [step, setStep] = useState<ResetStep>(() =>
    resetStepForCode(initialCode),
  );
  const [username, setUsername] = useState("");
  const [code, setCode] = useState(initialCode);
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [requested, setRequested] = useState(false);
  const [done, setDone] = useState(false);
  const [requestError, setRequestError] = useState<AuthErrorState | null>(null);
  const [redeemError, setRedeemError] = useState<AuthErrorState | null>(null);
  const requestHeadingRef = useRef<HTMLHeadingElement>(null);
  const redeemHeadingRef = useRef<HTMLHeadingElement>(null);
  const requestTabRef = useRef<HTMLButtonElement>(null);
  const redeemTabRef = useRef<HTMLButtonElement>(null);
  const signInRef = useRef<HTMLAnchorElement>(null);

  useLayoutEffect(() => {
    (step === "request"
      ? requestHeadingRef
      : redeemHeadingRef
    ).current?.focus();
  }, [step]);

  useLayoutEffect(() => {
    if (done) signInRef.current?.focus();
  }, [done]);

  useLayoutEffect(() => {
    if (requestError)
      focusAuthError(requestError, {
        fieldIds: { username: "reset-username" },
        formErrorId: "reset-request-error",
      });
  }, [requestError]);
  useLayoutEffect(() => {
    if (redeemError) {
      focusAuthError(redeemError, {
        fieldIds: {
          code: AUTH_FIELD_IDS.code,
          newPassword: AUTH_FIELD_IDS.newPassword,
          confirmNewPassword: AUTH_FIELD_IDS.confirmNewPassword,
        },
        formErrorId: "reset-redeem-error",
      });
    }
  }, [redeemError]);

  function selectStep(next: ResetStep) {
    setRequestError(null);
    setRedeemError(null);
    setStep(next);
  }

  function onStepTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const next =
      event.key === "ArrowLeft" || event.key === "Home"
        ? "request"
        : event.key === "ArrowRight" || event.key === "End"
          ? "redeem"
          : null;
    if (!next) return;
    event.preventDefault();
    selectStep(next);
    // Tab semantics keep the control focused after keyboard selection.
    requestAnimationFrame(() =>
      (next === "request" ? requestTabRef : redeemTabRef).current?.focus(),
    );
  }

  async function onRequest(event: FormEvent) {
    event.preventDefault();
    setRequestError(null);
    setRequesting(true);
    try {
      // The server intentionally returns the same outcome for unknown names.
      await api.post(`${API}/auth/reset-request`, {
        username: username.trim(),
      });
      setRequested(true);
    } catch (err) {
      setRequestError(
        err instanceof ApiError && err.status === 429
          ? { kind: "form", message: AUTH_RATE_LIMIT_ERROR }
          : {
              kind: "form",
              message:
                err instanceof ApiError ? err.message : AUTH_GENERIC_ERROR,
            },
      );
    } finally {
      setRequesting(false);
    }
  }

  async function onRedeem(event: FormEvent) {
    event.preventDefault();
    setRedeemError(null);
    const validation = validateResetPassword({
      code,
      newPassword,
      confirmNewPassword,
    });
    if (validation) {
      setRedeemError(validation);
      return;
    }
    setRedeeming(true);
    try {
      await api.post(`${API}/auth/reset-confirm`, {
        code: code.trim(),
        newPassword,
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400)
        setRedeemError({
          kind: "fields",
          fields: { code: AUTH_RESET_CODE_ERROR },
          focus: "code",
        });
      else if (err instanceof ApiError && err.status === 429)
        setRedeemError({ kind: "form", message: AUTH_RATE_LIMIT_ERROR });
      else
        setRedeemError({
          kind: "form",
          message: err instanceof ApiError ? err.message : AUTH_GENERIC_ERROR,
        });
    } finally {
      setRedeeming(false);
    }
  }

  const requestFormError =
    requestError?.kind === "form" ? requestError.message : null;
  const redeemFields = redeemError?.kind === "fields" ? redeemError.fields : {};
  const redeemFormError =
    redeemError?.kind === "form" ? redeemError.message : null;

  return (
    <div
      className="min-h-screen grid place-items-center p-6"
      style={{
        background:
          "radial-gradient(80% 60% at 50% 0%, var(--color-neutral-900) 0%, var(--color-bg) 70%)",
      }}
    >
      <div
        className="flex flex-col gap-4"
        style={{ width: "min(420px, 100%)" }}
      >
        <Card
          as="main"
          density="compact"
          elev="md"
          style={{ padding: "28px 26px", gap: 14 }}
          aria-labelledby="reset-page-title"
        >
          <h1 id="reset-page-title" style={{ margin: 0 }}>
            Reset your password
          </h1>
          <p className="text-muted" style={{ margin: 0, fontSize: 13 }}>
            A server admin approves requests and provides one-time reset codes.
          </p>
          <div
            role="tablist"
            aria-label="Password reset steps"
            className="flex gap-2"
          >
            <button
              id="reset-request-tab"
              ref={requestTabRef}
              type="button"
              className="btn btn-secondary"
              role="tab"
              aria-selected={step === "request"}
              aria-controls="reset-request-panel"
              tabIndex={step === "request" ? 0 : -1}
              onKeyDown={onStepTabKeyDown}
              onClick={() => selectStep("request")}
            >
              Request code
            </button>
            <button
              id="reset-redeem-tab"
              ref={redeemTabRef}
              type="button"
              className="btn btn-secondary"
              role="tab"
              aria-selected={step === "redeem"}
              aria-controls="reset-redeem-panel"
              tabIndex={step === "redeem" ? 0 : -1}
              onKeyDown={onStepTabKeyDown}
              onClick={() => selectStep("redeem")}
            >
              Use code
            </button>
          </div>
          {step === "request" ? (
            <section
              id="reset-request-panel"
              role="tabpanel"
              aria-labelledby="reset-request-tab"
            >
              <h2
                id="reset-request-heading"
                ref={requestHeadingRef}
                tabIndex={-1}
                style={{ margin: "0 0 8px" }}
              >
                Request a reset code
              </h2>
              {requested ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-col gap-3"
                >
                  <p
                    className="text-sm"
                    style={{ color: "var(--color-accent)", margin: 0 }}
                  >
                    Request received. Ask your server admin to approve it and
                    give you a one-time code.
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => selectStep("redeem")}
                  >
                    Use a reset code
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={onRequest}
                  className="flex flex-col gap-3"
                  noValidate
                >
                  <div className="field">
                    <label htmlFor="reset-username">Username</label>
                    <input
                      id="reset-username"
                      className="input"
                      value={username}
                      onChange={(e) => {
                        setUsername(e.target.value);
                        if (requestError) setRequestError(null);
                      }}
                      autoComplete="username"
                      required
                    />
                  </div>
                  {requestFormError && (
                    <p
                      id="reset-request-error"
                      role="alert"
                      tabIndex={-1}
                      className="text-sm text-rose-400"
                      style={{ margin: 0 }}
                    >
                      {requestFormError}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="btn btn-secondary btn-block"
                    style={{ minHeight: 44 }}
                    disabled={requesting}
                  >
                    {requesting ? "Sending…" : "Request a reset"}
                  </button>
                </form>
              )}
            </section>
          ) : (
            <section
              id="reset-redeem-panel"
              role="tabpanel"
              aria-labelledby="reset-redeem-tab"
            >
              <h2
                id="reset-redeem-heading"
                ref={redeemHeadingRef}
                tabIndex={-1}
                style={{ margin: "0 0 8px" }}
              >
                Use a reset code
              </h2>
              {done ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-col gap-3"
                >
                  <p
                    className="text-sm"
                    style={{ color: "var(--color-accent)", margin: 0 }}
                  >
                    Password updated. You can now sign in.
                  </p>
                  <Link ref={signInRef} to="/login" className="btn btn-primary">
                    Sign in
                  </Link>
                </div>
              ) : (
                <form
                  onSubmit={onRedeem}
                  className="flex flex-col gap-3"
                  noValidate
                >
                  <div className="field">
                    <label htmlFor={AUTH_FIELD_IDS.code}>Reset code</label>
                    <input
                      id={AUTH_FIELD_IDS.code}
                      className="input"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        if (redeemFields.code) setRedeemError(null);
                      }}
                      placeholder="cf_reset_…"
                      autoComplete="one-time-code"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      inputMode="text"
                      required
                      aria-invalid={redeemFields.code ? true : undefined}
                      aria-describedby={describedBy(
                        redeemFields.code && AUTH_ERROR_IDS.code,
                      )}
                    />
                    {redeemFields.code && (
                      <p
                        id={AUTH_ERROR_IDS.code}
                        role="alert"
                        className="text-sm text-rose-400"
                        style={{ margin: 0 }}
                      >
                        {redeemFields.code}
                      </p>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor={AUTH_FIELD_IDS.newPassword}>
                      New password
                    </label>
                    <PasswordInput
                      id={AUTH_FIELD_IDS.newPassword}
                      className="input"
                      value={newPassword}
                      onChange={(e) => {
                        setNewPassword(e.target.value);
                        if (redeemFields.newPassword) setRedeemError(null);
                      }}
                      placeholder="Min 8 characters"
                      autoComplete="new-password"
                      revealNoun="new password"
                      required
                      minLength={8}
                      aria-invalid={redeemFields.newPassword ? true : undefined}
                      aria-describedby={describedBy(
                        redeemFields.newPassword && AUTH_ERROR_IDS.newPassword,
                      )}
                    />
                    {redeemFields.newPassword && (
                      <p
                        id={AUTH_ERROR_IDS.newPassword}
                        role="alert"
                        className="text-sm text-rose-400"
                        style={{ margin: 0 }}
                      >
                        {redeemFields.newPassword}
                      </p>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor={AUTH_FIELD_IDS.confirmNewPassword}>
                      Confirm new password
                    </label>
                    <PasswordInput
                      id={AUTH_FIELD_IDS.confirmNewPassword}
                      className="input"
                      value={confirmNewPassword}
                      onChange={(e) => {
                        setConfirmNewPassword(e.target.value);
                        if (redeemFields.confirmNewPassword)
                          setRedeemError(null);
                      }}
                      autoComplete="new-password"
                      revealNoun="confirmed new password"
                      required
                      aria-invalid={
                        redeemFields.confirmNewPassword ? true : undefined
                      }
                      aria-describedby={describedBy(
                        redeemFields.confirmNewPassword &&
                          AUTH_ERROR_IDS.confirmNewPassword,
                      )}
                    />
                    {redeemFields.confirmNewPassword && (
                      <p
                        id={AUTH_ERROR_IDS.confirmNewPassword}
                        role="alert"
                        className="text-sm text-rose-400"
                        style={{ margin: 0 }}
                      >
                        {redeemFields.confirmNewPassword}
                      </p>
                    )}
                  </div>
                  {redeemFormError && (
                    <p
                      id="reset-redeem-error"
                      role="alert"
                      tabIndex={-1}
                      className="text-sm text-rose-400"
                      style={{ margin: 0 }}
                    >
                      {redeemFormError}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="btn btn-primary btn-block"
                    style={{ minHeight: 44 }}
                    disabled={redeeming}
                  >
                    {redeeming ? "Resetting…" : "Set new password"}
                  </button>
                </form>
              )}
            </section>
          )}
        </Card>
        <p className="text-center" style={{ fontSize: 12 }}>
          <Link to="/login" className="text-muted">
            ← Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

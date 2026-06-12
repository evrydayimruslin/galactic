import { type ReactElement, type ReactNode, useId } from "react";

import { hasLaunchAuthToken, signOutLaunch } from "../lib/auth";
import type { LaunchRouteDefinition, LaunchRouteKey } from "../lib/routes";
import { useSignInModal } from "./sign-in-modal";

export type IconName =
  | "arrow"
  | "check"
  | "copy"
  | "external"
  | "grid"
  | "key"
  | "menu"
  | "search"
  | "shield"
  | "spark"
  | "terminal"
  | "wallet";

interface LaunchShellProps {
  accountRoutes: LaunchRouteDefinition[];
  activeRoute: LaunchRouteKey;
  children: ReactNode;
  navigate: (to: string) => void;
  primaryRoutes: LaunchRouteDefinition[];
  title: string;
}

interface ButtonProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  href?: string;
  icon?: IconName;
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary" | "ghost";
}

interface PageHeaderProps {
  actions?: ReactNode;
  eyebrow?: string;
  intro?: string;
  title: string;
}

interface SectionProps {
  action?: ReactNode;
  children: ReactNode;
  eyebrow?: string;
  title?: string;
}

interface CardProps {
  children: ReactNode;
  className?: string;
  tone?: "default" | "ink" | "subtle";
}

interface MetricProps {
  label: string;
  value: string;
}

interface RouteLinkProps {
  children: ReactNode;
  className?: string;
  navigate: (to: string) => void;
  to: string;
}

export function LaunchShell({
  accountRoutes,
  activeRoute,
  children,
  navigate,
  primaryRoutes,
  title,
}: LaunchShellProps): ReactElement {
  const navRoutes = primaryRoutes.filter((route) => route.key !== "home");
  const signedIn = hasLaunchAuthToken();
  const openSignInModal = useSignInModal();
  const handleSignOut = () => {
    void signOutLaunch().finally(() => {
      window.location.href = "/";
    });
  };

  return (
    <div className="launch-shell">
      <header className="top-nav">
        <button
          className="wordmark-button"
          onClick={() => navigate("/")}
          type="button"
        >
          <Wordmark />
        </button>
        <nav className="desktop-nav" aria-label="Primary">
          {navRoutes.map((route) => (
            <button
              className={navClass(activeRoute, route.key)}
              key={route.key}
              onClick={() => navigate(route.path)}
              type="button"
            >
              {route.label}
            </button>
          ))}
        </nav>
        <div className="top-actions">
          <Button icon="copy" onClick={() => navigate("/install")} size="sm">
            Add to agent
          </Button>
          {signedIn
            ? (
              <Button onClick={handleSignOut} size="sm" variant="ghost">
                Sign out
              </Button>
            )
            : (
              <button
                className="signin-link"
                onClick={openSignInModal}
                type="button"
              >
                Sign in
              </button>
            )}
        </div>
      </header>

      <header className="mobile-nav">
        <button className="icon-button" aria-label="Open navigation" type="button">
          <Icon name="menu" />
        </button>
        <span className="mobile-title">{title}</span>
        <Button icon="copy" onClick={() => navigate("/install")} size="sm">
          Add
        </Button>
      </header>

      <main className="launch-main">{children}</main>

      <nav className="bottom-nav" aria-label="Account">
        {[...navRoutes, ...accountRoutes].map((route) => (
          <button
            className={navClass(activeRoute, route.key)}
            key={route.key}
            onClick={() => navigate(route.path)}
            type="button"
          >
            {route.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({
  actions,
  eyebrow,
  intro,
  title,
}: PageHeaderProps): ReactElement {
  return (
    <section className="page-hero">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {intro ? <p className="hero-copy">{intro}</p> : null}
      </div>
      {actions ? <div className="hero-actions">{actions}</div> : null}
    </section>
  );
}

export function Section({
  action,
  children,
  eyebrow,
  title,
}: SectionProps): ReactElement {
  return (
    <section className="launch-section">
      {(title || eyebrow || action) && (
        <div className="section-head">
          <div>
            {eyebrow ? <p className="section-label">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {action ? <div className="section-action">{action}</div> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({
  children,
  className = "",
  tone = "default",
}: CardProps): ReactElement {
  return <article className={`card card-${tone} ${className}`}>{children}</article>;
}

export function Button({
  children,
  className = "",
  disabled = false,
  href,
  icon,
  onClick,
  size = "md",
  variant = "primary",
}: ButtonProps): ReactElement {
  const content = (
    <>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </>
  );
  const classes = `launch-button button-${variant} button-${size} ${className}`;
  if (href) {
    return (
      <a className={classes} href={href}>
        {content}
      </a>
    );
  }
  return (
    <button className={classes} disabled={disabled} onClick={onClick} type="button">
      {content}
    </button>
  );
}

export function RouteButton({
  children,
  navigate,
  to,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  navigate: (to: string) => void;
  to: string;
}): ReactElement {
  return (
    <Button {...props} onClick={() => navigate(to)}>
      {children}
    </Button>
  );
}

export function RouteLink({
  children,
  className = "",
  navigate,
  to,
}: RouteLinkProps): ReactElement {
  return (
    <button
      className={`route-link ${className}`}
      onClick={() => navigate(to)}
      type="button"
    >
      {children}
    </button>
  );
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  const common = {
    fill: "none",
    height: size,
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.7,
    viewBox: "0 0 24 24",
    width: size,
  };
  switch (name) {
    case "arrow":
      return <svg {...common}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 5 5L20 7" /></svg>;
    case "copy":
      return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
    case "external":
      return <svg {...common}><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>;
    case "grid":
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
    case "key":
      return <svg {...common}><circle cx="7.5" cy="14.5" r="4.5" /><path d="M11 11 21 1" /><path d="m17 5 3 3" /></svg>;
    case "menu":
      return <svg {...common}><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "spark":
      return <svg height={size} viewBox="0 0 24 24" width={size}><path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z" fill="currentColor" /></svg>;
    case "terminal":
      return <svg {...common}><path d="m6 8 4 4-4 4" /><path d="M12 16h6" /></svg>;
    case "wallet":
      return <svg {...common}><path d="M4 7a2 2 0 0 1 2-2h14v14H6a2 2 0 0 1-2-2Z" /><path d="M16 12h4" /></svg>;
  }
}

export function Wordmark(): ReactElement {
  const maskId = `wm${useId().replace(/:/gu, "")}`;
  return (
    <span className="wordmark">
      <svg
        aria-hidden="true"
        className="wordmark-mark"
        shapeRendering="geometricPrecision"
        viewBox="44 56 168 144"
      >
        <mask
          height="256"
          id={maskId}
          maskUnits="userSpaceOnUse"
          width="256"
          x="0"
          y="0"
        >
          <rect fill="black" height="256" width="256" x="0" y="0" />
          <circle cx="128" cy="116.02" fill="white" r="84" />
          <circle cx="128" cy="98.02" fill="black" r="72.24" />
        </mask>
        <circle
          cx="128"
          cy="116.02"
          fill="currentColor"
          mask={`url(#${maskId})`}
          r="84"
        />
      </svg>
      <span>Ultralight</span>
    </span>
  );
}

export function Avatar({ color = "#0a0a0a", name }: { color?: string; name: string }): ReactElement {
  const label = name.replace("@", "").slice(0, 1).toUpperCase() || "?";
  return <span className="avatar" style={{ background: color }}>{label}</span>;
}

export function Mono({ children }: { children: ReactNode }): ReactElement {
  return <span className="mono">{children}</span>;
}

export function Pill({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "green" | "amber" | "red";
}): ReactElement {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Metric({ label, value }: MetricProps): ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function CodeBlock({ children }: { children: string }): ReactElement {
  return (
    <pre className="code-block">
      <code>{children}</code>
    </pre>
  );
}

export function EmptyState({
  children,
  icon = "spark",
  title,
}: {
  children: ReactNode;
  icon?: IconName;
  title: string;
}): ReactElement {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon name={icon} size={20} /></span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function navClass(activeRoute: LaunchRouteKey, routeKey: LaunchRouteKey): string {
  return activeRoute === routeKey ? "nav-item active" : "nav-item";
}

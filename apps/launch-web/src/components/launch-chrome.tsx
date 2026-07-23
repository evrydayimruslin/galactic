import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import type { LaunchNotification } from "../../../../shared/contracts/launch.ts";
import { launchApi } from "../lib/api";
import { hasLaunchAuthToken } from "../lib/auth";
import type { LaunchNavigate } from "../lib/navigation";
import type { LaunchRouteDefinition, LaunchRouteKey } from "../lib/routes";
import { AddToAgentButton } from "../pages/foundation-pages";
import { useSignInModal } from "./sign-in-modal";

export type IconName =
  | "arrow"
  | "bell"
  | "check"
  | "copy"
  | "edit"
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
  navigate: LaunchNavigate;
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
  navigate: LaunchNavigate;
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

  // A subtle shadow fades in once the page scrolls (no static border).
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="launch-shell">
      <header className={scrolled ? "top-nav scrolled" : "top-nav"}>
        <button
          className="wordmark-button"
          onClick={() => navigate("/")}
          type="button"
        >
          <Wordmark />
        </button>
        <nav className="desktop-nav" aria-label="Primary">
          {signedIn
            ? (
              <>
                {navRoutes.map((route) => (
                  <button
                    className={navClass(activeRoute, route.key)}
                    data-label={route.label}
                    key={route.key}
                    onClick={() => navigate(route.path)}
                    type="button"
                  >
                    <span>{route.label}</span>
                  </button>
                ))}
                <button
                  className={navClass(activeRoute, "settings")}
                  data-label="Profile"
                  onClick={() => navigate("/account")}
                  type="button"
                >
                  <span>Profile</span>
                </button>
              </>
            )
            : null}
        </nav>
        <div className="top-actions">
          <AddToAgentButton
            label={signedIn ? "Add to agent" : "Connect Galactic"}
            size="sm"
            variant="ghost"
          />
          {signedIn
            ? <NotificationBell navigate={navigate} />
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
        <AddToAgentButton
          label={signedIn ? "Add" : "Connect"}
          size="sm"
        />
      </header>

      <main className="launch-main">{children}</main>

      {signedIn
        ? (
          <nav className="bottom-nav" aria-label="Account">
            {[...navRoutes, ...accountRoutes].map((route) => (
              <button
                className={navClass(activeRoute, route.key)}
                data-label={route.label}
                key={route.key}
                onClick={() => navigate(route.path)}
                type="button"
              >
                <span>{route.label}</span>
              </button>
            ))}
          </nav>
        )
        : null}
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
  navigate: LaunchNavigate;
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

function notifRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// Owner notification bell (Tier 2A). Reads the same rows as gx.notifications;
// surfaces auto-pause / budget events for signed-in owners without a reload.
function NotificationBell(
  { navigate }: { navigate: LaunchNavigate },
): ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LaunchNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = async (): Promise<void> => {
    try {
      const res = await launchApi.listNotifications({ limit: 30 });
      setItems(res.notifications);
      setUnread(res.unread_count);
    } catch {
      // Best-effort: the bell just shows no badge if the fetch fails.
    }
  };

  // Badge on mount + light 60s polling so an away agent's pause surfaces
  // without a reload; the dropdown refetches on open.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void refresh();
    };
    tick();
    const id = window.setInterval(tick, 60000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = async (): Promise<void> => {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      await refresh();
      setLoading(false);
    }
  };

  const markAll = async (): Promise<void> => {
    try {
      await launchApi.markNotificationsRead({ all: true });
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
      setUnread(0);
    } catch {
      // Best-effort.
    }
  };

  const onItemClick = async (n: LaunchNotification): Promise<void> => {
    if (!n.read_at) {
      try {
        await launchApi.markNotificationsRead({ ids: [n.id] });
        const now = new Date().toISOString();
        setItems((prev) =>
          prev.map((x) => (x.id === n.id ? { ...x, read_at: now } : x))
        );
        setUnread((u) => Math.max(0, u - 1));
      } catch {
        // Best-effort.
      }
    }
    // Only follow an in-app relative path. A notification action_url is a
    // server-stored string; restricting to a single leading "/" (not "//",
    // which is protocol-relative) blocks javascript: URLs and off-origin
    // redirects that navigate()/App.tsx would otherwise execute.
    if (
      typeof n.action_url === "string" &&
      n.action_url.startsWith("/") &&
      !n.action_url.startsWith("//")
    ) {
      navigate(n.action_url);
      setOpen(false);
    }
  };

  return (
    <div className="notif-bell" ref={ref}>
      <button
        className="icon-button notif-bell-button"
        aria-label={unread > 0
          ? `Notifications, ${unread} unread`
          : "Notifications"}
        aria-expanded={open}
        onClick={() => void toggle()}
        type="button"
      >
        <Icon name="bell" />
        {unread > 0
          ? <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>
          : null}
      </button>
      {open
        ? (
          <div className="notif-panel" role="dialog" aria-label="Notifications">
            <div className="notif-panel-head">
              <strong>Notifications</strong>
              {unread > 0
                ? (
                  <button
                    className="notif-markall"
                    onClick={() => void markAll()}
                    type="button"
                  >
                    Mark all read
                  </button>
                )
                : null}
            </div>
            <div className="notif-list">
              {loading && items.length === 0
                ? <p className="notif-empty">Loading…</p>
                : items.length === 0
                ? <p className="notif-empty">You're all caught up.</p>
                : items.map((n) => (
                  <button
                    key={n.id}
                    className={`notif-item${
                      n.read_at ? "" : " notif-item-unread"
                    } notif-sev-${n.severity}`}
                    onClick={() => void onItemClick(n)}
                    type="button"
                  >
                    <span className="notif-item-dot" aria-hidden="true" />
                    <span className="notif-item-body">
                      <span className="notif-item-title">{n.title}</span>
                      {n.body
                        ? <span className="notif-item-sub">{n.body}</span>
                        : null}
                      <span className="notif-item-time">
                        {notifRelativeTime(n.created_at)}
                      </span>
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )
        : null}
    </div>
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
    case "bell":
      return <svg {...common}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10.5 20a1.8 1.8 0 0 0 3 0" /></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 5 5L20 7" /></svg>;
    case "copy":
      return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
    case "edit":
      return <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
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
  return (
    <span aria-label="Galactic" className="wordmark" role="img">
      <span aria-hidden="true" className="wordmark-mark" />
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

// Icons used by the premium UI exploration. Lifted from ui_kits/desktop/Icons.jsx.

const PUI_ICON_DEFAULTS = {
  width: 16, height: 16, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
  strokeLinecap: 'round', strokeLinejoin: 'round',
};

const PUIIcon = ({ children, size = 16, ...props }) => (
  <svg {...PUI_ICON_DEFAULTS} width={size} height={size} {...props}>{children}</svg>
);

const IconCompass = (p) => <PUIIcon {...p}><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></PUIIcon>;
const IconPackage = (p) => <PUIIcon {...p}><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></PUIIcon>;
const IconCirclePlus = (p) => <PUIIcon {...p}><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/></PUIIcon>;
const IconWrench = (p) => <PUIIcon {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></PUIIcon>;
const IconStore = (p) => <PUIIcon {...p}><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></PUIIcon>;
const IconSettings = (p) => <PUIIcon {...p}><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/><circle cx="12" cy="12" r="3"/></PUIIcon>;
const IconArrowUp = (p) => <PUIIcon {...p} strokeWidth={2}><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></PUIIcon>;
const IconPaperclip = (p) => <PUIIcon {...p}><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.93 8.8l-8.58 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></PUIIcon>;
const IconCheck = (p) => <PUIIcon {...p}><polyline points="20 6 9 17 4 12"/></PUIIcon>;
const IconSearch = (p) => <PUIIcon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></PUIIcon>;
const IconBolt = (p) => <PUIIcon {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></PUIIcon>;
const IconShare = (p) => <PUIIcon {...p}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></PUIIcon>;
const IconBeaker = (p) => <PUIIcon {...p}><path d="M4.5 3h15"/><path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3"/><path d="M6 14h12"/></PUIIcon>;
const IconWallet = (p) => <PUIIcon {...p}><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></PUIIcon>;
const IconUser = (p) => <PUIIcon {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></PUIIcon>;
const IconCornerDownLeft = (p) => <PUIIcon {...p}><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></PUIIcon>;
const IconChevronDown = (p) => <PUIIcon {...p}><polyline points="6 9 12 15 18 9"/></PUIIcon>;
const IconChevronRight = (p) => <PUIIcon {...p}><polyline points="9 18 15 12 9 6"/></PUIIcon>;
const IconPlus = (p) => <PUIIcon {...p}><path d="M12 5v14"/><path d="M5 12h14"/></PUIIcon>;
const IconFolder = (p) => <PUIIcon {...p}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></PUIIcon>;
const IconSlash = (p) => <PUIIcon {...p}><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M14 8l-4 8"/></PUIIcon>;
const IconConnector = (p) => <PUIIcon {...p}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></PUIIcon>;
const IconPlugin = (p) => <PUIIcon {...p}><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6Z"/><path d="M12 18v4"/></PUIIcon>;
const IconPencil = (p) => <PUIIcon {...p}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></PUIIcon>;
const IconKey = (p) => <PUIIcon {...p}><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10.5 12.5 9.5-9.5"/><path d="m14 9 3 3"/></PUIIcon>;
const IconSparkles = (p) => <PUIIcon {...p}><path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z"/></PUIIcon>;

window.PUI_Icons = { IconCompass, IconPackage, IconCirclePlus, IconWrench, IconStore, IconSettings, IconArrowUp, IconPaperclip, IconCheck, IconSearch, IconBolt, IconShare, IconBeaker, IconWallet, IconUser, IconCornerDownLeft, IconChevronDown, IconChevronRight, IconPlus, IconFolder, IconSlash, IconConnector, IconPlugin, IconPencil, IconKey, IconSparkles };

import { SECTIONS, useNav } from "@/stores/nav";

/** Slim icon rail on desktop/tablet. */
export function SideRail() {
  const { section, go } = useNav();
  return (
    <nav aria-label="Sections" className="hidden w-[72px] shrink-0 flex-col items-center gap-3 border-r border-white/[0.06] bg-[rgba(11,13,17,0.35)] py-4 backdrop-blur-md md:flex">
      <img src="/icon.svg" alt="" className="mb-3 size-9 rounded-[10px]" />
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => go(id)}
          aria-current={section === id ? "page" : undefined}
          aria-label={label}
          title={label}
          className={`grid size-11 place-items-center rounded-[14px] transition-all duration-200 ${
            section === id ? "border border-amber/50 bg-amber/10 text-amber-light glow-amber" : "text-ink-2 hover:bg-white/5 hover:text-ink"
          }`}
        >
          <Icon size={19} />
        </button>
      ))}
    </nav>
  );
}

/** Bottom tab bar on phones. */
export function MobileTabs() {
  const { section, go } = useNav();
  return (
    <nav
      aria-label="Sections"
      className="glass-thin fixed inset-x-0 bottom-0 z-40 flex justify-around border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => go(id)}
          aria-current={section === id ? "page" : undefined}
          className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-1 ${section === id ? "text-amber-light" : "text-ink-3"}`}
        >
          <Icon size={19} />
          <span className="text-[10px] font-medium">{label}</span>
        </button>
      ))}
    </nav>
  );
}

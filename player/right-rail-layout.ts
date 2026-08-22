export interface RightRailPaneAllocation {
  readonly timers: number;
  readonly actions: number;
}

interface RightRailLayoutElements {
  readonly rightZone: HTMLElement;
  readonly compactTimerHost: HTMLElement;
  readonly timerWrap: HTMLElement;
  readonly timerList: HTMLElement;
  readonly actions: HTMLElement;
}

export interface RightRailLayoutController {
  sync(compactTimers: boolean): void;
  queueSync(): void;
}

export function allocateRightRailPaneHeights(
  availableHeight: number,
  timerRequiredHeight: number,
  actionRequiredHeight: number,
): RightRailPaneAllocation {
  const available = finiteNonNegative(availableHeight);
  const timerRequired = finiteNonNegative(timerRequiredHeight);
  const actionRequired = finiteNonNegative(actionRequiredHeight);

  if (available === 0) return { timers: 0, actions: 0 };
  if (timerRequired === 0) return { timers: 0, actions: available };
  if (actionRequired === 0) {
    const timers = Math.min(timerRequired, available);
    return { timers, actions: available - timers };
  }

  const half = available / 2;
  if (timerRequired <= half) {
    return { timers: timerRequired, actions: available - timerRequired };
  }
  if (actionRequired <= half) {
    return { timers: available - actionRequired, actions: actionRequired };
  }
  return { timers: half, actions: available - half };
}

export function createRightRailLayoutController(
  elements: RightRailLayoutElements,
): RightRailLayoutController {
  const {
    rightZone,
    compactTimerHost,
    timerWrap,
    timerList,
    actions,
  } = elements;
  let compactTimers = false;
  let syncQueued = false;

  const observer = new ResizeObserver(queueSync);
  observer.observe(rightZone);
  observer.observe(timerList);
  observer.observe(actions);

  return { sync, queueSync };

  function sync(nextCompactTimers: boolean = compactTimers): void {
    compactTimers = nextCompactTimers;
    moveTimerPresentation();

    if (compactTimers) {
      setTimerPaneSize(0);
      return;
    }

    const availableHeight = rightZone.clientHeight;
    const timerRequiredHeight = timerWrap.hidden || getComputedStyle(timerWrap).display === "none"
      ? 0
      : naturalStackBlockSize(timerList) + verticalPadding(timerWrap);
    const actionRequiredHeight = naturalStackBlockSize(actions);
    const allocation = allocateRightRailPaneHeights(
      availableHeight,
      timerRequiredHeight,
      actionRequiredHeight,
    );
    setTimerPaneSize(allocation.timers);
  }

  function queueSync(): void {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      sync();
    });
  }

  function moveTimerPresentation(): void {
    if (compactTimers) {
      if (timerWrap.parentElement !== compactTimerHost) compactTimerHost.append(timerWrap);
      return;
    }
    if (timerWrap.parentElement !== rightZone) rightZone.prepend(timerWrap);
  }

  function setTimerPaneSize(value: number): void {
    const pixels = `${Math.max(0, value)}px`;
    if (rightZone.style.getPropertyValue("--timer-pane-size") !== pixels) {
      rightZone.style.setProperty("--timer-pane-size", pixels);
    }
  }
}

function naturalStackBlockSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const children = [...element.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.getClientRects().length > 0,
  );
  if (children.length === 0) return 0;

  const childrenHeight = children.reduce(
    (total, child) => total + child.getBoundingClientRect().height,
    0,
  );
  const gap = children.length > 1
    ? finiteNonNegative(Number.parseFloat(style.rowGap)) * (children.length - 1)
    : 0;
  return childrenHeight + gap + verticalPadding(element);
}

function verticalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return finiteNonNegative(Number.parseFloat(style.paddingTop))
    + finiteNonNegative(Number.parseFloat(style.paddingBottom));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

import { Capacitor } from '@capacitor/core';
import { AdMob, BannerAdOptions, BannerAdSize, BannerAdPosition } from '@capacitor-community/admob';

// Production ad unit IDs only (test IDs removed by request)
const BANNER_ID = 'ca-app-pub-8496227439538798/2899800506';
const INTERSTITIAL_ID = 'ca-app-pub-8496227439538798/8159866041';
const REWARDED_ID = 'ca-app-pub-8496227439538798/9137905794';
const APP_OPEN_ID = 'ca-app-pub-8496227439538798/2455637861';
const REWARDED_INTERSTITIAL_ID = 'ca-app-pub-8496227439538798/6852855908';

// Freshness limits (refresh before Google approximate lifetimes)
const MAX_AGE = 55 * 60 * 1000;          // ~55 min for interstitial / rewarded
const APP_OPEN_MAX_AGE = 3.5 * 60 * 60 * 1000; // ~3.5 h for app open

let initPromise: Promise<void> | null = null;
let interstitialPromise: Promise<boolean> | null = null;
let rewardedPromise: Promise<boolean> | null = null;
let rewardedInterstitialPromise: Promise<boolean> | null = null;
let appOpenPromise: Promise<boolean> | null = null;

let interstitialReady = false;
let rewardedReady = false;
let rewardedInterstitialReady = false;
let appOpenReady = false;

let interstitialAt = 0;
let rewardedAt = 0;
let rewardedInterstitialAt = 0;
let appOpenAt = 0;

let bannerShown = false;
let bannerPosition: BannerAdPosition | null = null;
let appOpenShowing = false;
let fullScreenAdShowing = false;

let retryTimers: Record<string, ReturnType<typeof setTimeout> | null> = {
  i: null,
  r: null,
  ri: null,
  ao: null,
  b: null,
};

// Fast first retry, max 10 seconds
let retryDelay: Record<string, number> = {
  i: 300,
  r: 300,
  ri: 300,
  ao: 300,
  b: 1000,
};

let maintenanceTimer: ReturnType<typeof setInterval> | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fresh = (ready: boolean, at: number, age: number) =>
  ready && at > 0 && Date.now() - at < age;

export async function initAds() {
  if (!Capacitor.isNativePlatform()) return;
  if (!initPromise) {
    initPromise = AdMob.initialize().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  await initPromise;
}

function retry(kind: keyof typeof retryTimers, fn: () => void) {
  if (retryTimers[kind]) return;
  const delay = retryDelay[kind] || 1000;
  // Cap at 10 seconds
  retryDelay[kind] = Math.min(delay * 2, 10000);
  retryTimers[kind] = setTimeout(() => {
    retryTimers[kind] = null;
    fn();
  }, delay);
}

/**
 * Show a permanent top banner (preferred for reliability).
 * Position switching is avoided to prevent destroy/recreate failures.
 */
export async function showBanner(position: 'top' | 'bottom' = 'top') {
  if (!Capacitor.isNativePlatform()) return;

  const target =
    position === 'top' ? BannerAdPosition.TOP_CENTER : BannerAdPosition.BOTTOM_CENTER;

  try {
    await initAds();

    // Already showing in the correct position → just resume
    if (bannerShown && bannerPosition === target) {
      try {
        await AdMob.resumeBanner();
        return;
      } catch {
        bannerShown = false;
        bannerPosition = null;
      }
    }

    // Different position or not shown → remove old and create new
    if (bannerShown) {
      try {
        await AdMob.removeBanner();
      } catch {}
      bannerShown = false;
      bannerPosition = null;
    }

    const options: BannerAdOptions = {
      adId: BANNER_ID,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: target,
      margin: 0,
      isTesting: false,
    };

    await AdMob.showBanner(options);
    bannerShown = true;
    bannerPosition = target;
    retryDelay.b = 1000;
  } catch (e) {
    bannerShown = false;
    bannerPosition = null;
    console.error('[AdMob] banner', e);
    retry('b', () => void showBanner(position));
  }
}

export async function hideBanner() {
  if (!Capacitor.isNativePlatform() || !bannerShown) return;
  try {
    await AdMob.removeBanner();
  } catch {}
  bannerShown = false;
  bannerPosition = null;
}

export async function preloadInterstitial(force = false) {
  if (!Capacitor.isNativePlatform()) return false;
  if (!force && fresh(interstitialReady, interstitialAt, MAX_AGE)) return true;
  if (interstitialPromise) return interstitialPromise;

  interstitialReady = false;
  interstitialAt = 0;

  interstitialPromise = (async () => {
    try {
      await initAds();
      await AdMob.prepareInterstitial({ adId: INTERSTITIAL_ID, isTesting: false });
      interstitialReady = true;
      interstitialAt = Date.now();
      retryDelay.i = 300;
      return true;
    } catch (e) {
      console.error('[AdMob] interstitial preload', e);
      retry('i', () => void preloadInterstitial(true));
      return false;
    } finally {
      interstitialPromise = null;
    }
  })();

  return interstitialPromise;
}

export async function showInterstitial() {
  if (!Capacitor.isNativePlatform() || fullScreenAdShowing) return false;

  try {
    await initAds();

    const deadline = Date.now() + 6000;
    while (!fresh(interstitialReady, interstitialAt, MAX_AGE) && Date.now() < deadline) {
      await preloadInterstitial();
      if (!fresh(interstitialReady, interstitialAt, MAX_AGE)) await sleep(300);
    }

    if (!fresh(interstitialReady, interstitialAt, MAX_AGE)) return false;

    fullScreenAdShowing = true;
    await AdMob.showInterstitial();
    interstitialReady = false;
    interstitialAt = 0;
    retryDelay.i = 300;
    void preloadInterstitial(true);
    return true;
  } catch (e) {
    interstitialReady = false;
    interstitialAt = 0;
    console.error('[AdMob] interstitial show', e);
    retry('i', () => void preloadInterstitial(true));
    return false;
  } finally {
    fullScreenAdShowing = false;
  }
}

export async function preloadRewarded(force = false) {
  if (!Capacitor.isNativePlatform()) return false;
  if (!force && fresh(rewardedReady, rewardedAt, MAX_AGE)) return true;
  if (rewardedPromise) return rewardedPromise;

  rewardedReady = false;
  rewardedAt = 0;

  rewardedPromise = (async () => {
    try {
      await initAds();
      await AdMob.prepareRewardVideoAd({ adId: REWARDED_ID, isTesting: false });
      rewardedReady = true;
      rewardedAt = Date.now();
      retryDelay.r = 300;
      return true;
    } catch (e) {
      console.error('[AdMob] rewarded preload', e);
      retry('r', () => void preloadRewarded(true));
      return false;
    } finally {
      rewardedPromise = null;
    }
  })();

  return rewardedPromise;
}

export async function showRewarded() {
  if (!Capacitor.isNativePlatform() || fullScreenAdShowing) return false;

  try {
    await initAds();

    const deadline = Date.now() + 8000;
    while (!fresh(rewardedReady, rewardedAt, MAX_AGE) && Date.now() < deadline) {
      await preloadRewarded();
      if (!fresh(rewardedReady, rewardedAt, MAX_AGE)) await sleep(300);
    }

    if (!fresh(rewardedReady, rewardedAt, MAX_AGE)) return false;

    fullScreenAdShowing = true;
    const reward = await AdMob.showRewardVideoAd();
    rewardedReady = false;
    rewardedAt = 0;
    retryDelay.r = 300;
    void preloadRewarded(true);
    return Number(reward?.amount || 0) > 0;
  } catch (e) {
    rewardedReady = false;
    rewardedAt = 0;
    console.error('[AdMob] rewarded show', e);
    retry('r', () => void preloadRewarded(true));
    return false;
  } finally {
    fullScreenAdShowing = false;
  }
}

export async function preloadRewardedInterstitial(force = false) {
  if (!Capacitor.isNativePlatform()) return false;
  if (!force && fresh(rewardedInterstitialReady, rewardedInterstitialAt, MAX_AGE)) return true;
  if (rewardedInterstitialPromise) return rewardedInterstitialPromise;

  rewardedInterstitialReady = false;
  rewardedInterstitialAt = 0;

  rewardedInterstitialPromise = (async () => {
    try {
      await initAds();
      await AdMob.prepareRewardInterstitialAd({
        adId: REWARDED_INTERSTITIAL_ID,
        isTesting: false,
      });
      rewardedInterstitialReady = true;
      rewardedInterstitialAt = Date.now();
      retryDelay.ri = 300;
      return true;
    } catch (e) {
      console.error('[AdMob] rewarded interstitial preload', e);
      retry('ri', () => void preloadRewardedInterstitial(true));
      return false;
    } finally {
      rewardedInterstitialPromise = null;
    }
  })();

  return rewardedInterstitialPromise;
}

export async function showRewardedInterstitial() {
  if (!Capacitor.isNativePlatform() || fullScreenAdShowing) return false;

  try {
    await initAds();

    const deadline = Date.now() + 8000;
    while (
      !fresh(rewardedInterstitialReady, rewardedInterstitialAt, MAX_AGE) &&
      Date.now() < deadline
    ) {
      await preloadRewardedInterstitial();
      if (!fresh(rewardedInterstitialReady, rewardedInterstitialAt, MAX_AGE)) await sleep(300);
    }

    if (!fresh(rewardedInterstitialReady, rewardedInterstitialAt, MAX_AGE)) return false;

    fullScreenAdShowing = true;
    const reward = await AdMob.showRewardInterstitialAd();
    rewardedInterstitialReady = false;
    rewardedInterstitialAt = 0;
    retryDelay.ri = 300;
    void preloadRewardedInterstitial(true);
    return Number(reward?.amount || 0) > 0;
  } catch (e) {
    rewardedInterstitialReady = false;
    rewardedInterstitialAt = 0;
    console.error('[AdMob] rewarded interstitial show', e);
    retry('ri', () => void preloadRewardedInterstitial(true));
    return false;
  } finally {
    fullScreenAdShowing = false;
  }
}

export async function preloadAppOpen(force = false) {
  if (!Capacitor.isNativePlatform()) return false;
  if (!force && fresh(appOpenReady, appOpenAt, APP_OPEN_MAX_AGE)) return true;
  if (appOpenPromise) return appOpenPromise;

  appOpenReady = false;
  appOpenAt = 0;

  appOpenPromise = (async () => {
    try {
      await initAds();
      await AdMob.loadAppOpen({ adId: APP_OPEN_ID });
      appOpenReady = true;
      appOpenAt = Date.now();
      retryDelay.ao = 300;
      return true;
    } catch (e) {
      console.error('[AdMob] app open preload', e);
      retry('ao', () => void preloadAppOpen(true));
      return false;
    } finally {
      appOpenPromise = null;
    }
  })();

  return appOpenPromise;
}

export async function showAppOpenIfAppropriate(maxWaitMs = 0) {
  if (!Capacitor.isNativePlatform() || appOpenShowing || fullScreenAdShowing) return false;

  try {
    await initAds();

    const preloadPromise = preloadAppOpen();
    if (maxWaitMs > 0) {
      await Promise.race([preloadPromise, sleep(maxWaitMs)]);
    } else {
      await preloadPromise;
    }

    if (!fresh(appOpenReady, appOpenAt, APP_OPEN_MAX_AGE)) return false;

    const loaded = await AdMob.isAppOpenLoaded({ adId: APP_OPEN_ID });
    if (!loaded.value) {
      appOpenReady = false;
      appOpenAt = 0;
      void preloadAppOpen(true);
      return false;
    }

    appOpenShowing = true;
    fullScreenAdShowing = true;
    await AdMob.showAppOpen({ adId: APP_OPEN_ID });
    appOpenReady = false;
    appOpenAt = 0;

    // Immediately prepare the next one
    void preloadAppOpen(true);
    return true;
  } catch (e) {
    appOpenReady = false;
    appOpenAt = 0;
    console.error('[AdMob] app open show', e);
    retry('ao', () => void preloadAppOpen(true));
    return false;
  } finally {
    appOpenShowing = false;
    fullScreenAdShowing = false;
  }
}

/**
 * Keeps full-screen ad inventory warm.
 * Called on startup and periodically while the app is open.
 */
export function maintainAds() {
  if (!Capacitor.isNativePlatform()) return;

  void initAds()
    .then(() => {
      void preloadInterstitial();
      void preloadRewarded();
      void preloadRewardedInterstitial();
      void preloadAppOpen();
    })
    .catch(() => undefined);

  if (!maintenanceTimer) {
    // Refresh every 4 minutes so ads stay fresh
    maintenanceTimer = setInterval(() => {
      void preloadInterstitial();
      void preloadRewarded();
      void preloadRewardedInterstitial();
      void preloadAppOpen();
    }, 4 * 60 * 1000);
  }
}

/**
 * Strong recovery path – used when the app returns after long inactivity.
 */
export function recoverAds() {
  if (!Capacitor.isNativePlatform()) return;

  // Reset retry delays so recovery is fast
  retryDelay = { i: 300, r: 300, ri: 300, ao: 300, b: 1000 };

  void initAds()
    .then(() => {
      void showBanner('top');
      maintainAds();
    })
    .catch(() => undefined);
}

/** Simple readiness helpers for the UI layer */
export function isInterstitialReady() {
  return fresh(interstitialReady, interstitialAt, MAX_AGE);
}

export function isRewardedReady() {
  return fresh(rewardedReady, rewardedAt, MAX_AGE);
}

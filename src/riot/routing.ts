/** Regional routing values used by match-v5. */
export type Region = 'americas' | 'europe' | 'asia' | 'sea';
/** account-v1 only serves these three clusters. */
export type AccountRegion = 'americas' | 'europe' | 'asia';

const PLATFORM_TO_REGION: Record<string, Region> = {
  na1: 'americas',
  br1: 'americas',
  la1: 'americas',
  la2: 'americas',
  euw1: 'europe',
  eun1: 'europe',
  tr1: 'europe',
  ru: 'europe',
  me1: 'europe',
  kr: 'asia',
  jp1: 'asia',
  oc1: 'sea',
  ph2: 'sea',
  sg2: 'sea',
  th2: 'sea',
  tw2: 'sea',
  vn2: 'sea',
};

export function regionFor(platform: string): Region {
  const region = PLATFORM_TO_REGION[platform.toLowerCase()];
  if (!region) {
    throw new Error(
      `Unknown platform "${platform}". Expected one of: ${Object.keys(PLATFORM_TO_REGION).join(', ')}`,
    );
  }
  return region;
}

/** Riot IDs are global, so any account cluster works; pick the nearest one. */
export function accountRegionFor(platform: string): AccountRegion {
  const region = regionFor(platform);
  return region === 'sea' ? 'asia' : region;
}

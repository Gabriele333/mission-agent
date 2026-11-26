import type { Surface } from '../types.js';

/** The surfaces that run now, and the rule of §F.1 for the default surface. */
export interface SurfaceSet {
  get(id: string): Surface | undefined;
  list(): Surface[];
  add(surface: Surface): void;
  remove(id: string): void;
  /**
   * The default surface of the agent configuration. When it does not run, for example because
   * the bot token is missing, the terminal takes its place, so that a message is never lost.
   */
  defaultSurface(): Surface;
}

export function createSurfaceSet(defaultId: () => string, fallback: Surface): SurfaceSet {
  const surfaces = new Map<string, Surface>([[fallback.id, fallback]]);
  return {
    get: (id) => surfaces.get(id),
    list: () => [...surfaces.values()],
    add(surface) {
      surfaces.set(surface.id, surface);
    },
    remove(id) {
      if (id !== fallback.id) surfaces.delete(id);
    },
    defaultSurface() {
      return surfaces.get(defaultId()) ?? fallback;
    },
  };
}

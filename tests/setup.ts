import '@testing-library/jest-dom/vitest';

const isJsdom = typeof window !== 'undefined' && typeof document !== 'undefined';

// jsdom does not implement matchMedia, which the reduced-motion aware styles and
// some components query. Provide a minimal but honest stub.
if (isJsdom && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Recharts relies on ResizeObserver for responsive containers.
if (isJsdom && !('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

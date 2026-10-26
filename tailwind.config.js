/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        lab: {
          bg: '#071B12',
          surface: '#0B1D13',
          raised: '#102B1B',
          card: '#142D1C',
          hover: '#193822',
          border: '#29432B',
          'border-strong': '#3A5A3D',
          accent: '#B5E94B',
          'accent-dim': '#8FBE33',
          cyan: '#5DDBCA',
          text: '#E8F0E5',
          muted: '#A4B9A2',
          faint: '#6E856D',
          warn: '#F3B66D',
          danger: '#FF7474',
          demo: '#C79BF2',
        },
      },
      fontFamily: {
        sans: [
          '"Inter"',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"JetBrains Mono"', '"SFMono-Regular"', 'Consolas', '"Liberation Mono"', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        lab: '6px',
        'lab-lg': '10px',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(181,233,75,0.25), 0 0 24px -8px rgba(181,233,75,0.35)',
        panel: '0 1px 0 0 rgba(255,255,255,0.02) inset, 0 8px 24px -18px rgba(0,0,0,0.9)',
      },
      transitionDuration: {
        fast: '120ms',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        'paper-alt': 'rgb(var(--paper-alt) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--ink-soft) / <alpha-value>)',
        'ink-faint': 'rgb(var(--ink-faint) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        supported: 'rgb(var(--supported) / <alpha-value>)',
        conflict: 'rgb(var(--conflict) / <alpha-value>)',
        insufficient: 'rgb(var(--insufficient) / <alpha-value>)',
        pending: 'rgb(var(--pending) / <alpha-value>)',
        stale: 'rgb(var(--stale) / <alpha-value>)',
      },
      fontFamily: {
        serif: ['"Fraunces Variable"', '"Noto Serif SC"', 'Songti SC', 'serif'],
        sans: ['"Manrope Variable"', '"Noto Sans SC"', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['"SF Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '24px',
        cover: '18px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(35,32,43,0.04), 0 12px 32px rgba(35,32,43,0.07)',
        'card-hover': '0 2px 4px rgba(35,32,43,0.05), 0 20px 48px rgba(35,32,43,0.12)',
        glass: '0 8px 32px rgba(35,32,43,0.10), inset 0 1px 0 rgba(255,255,255,0.8)',
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}

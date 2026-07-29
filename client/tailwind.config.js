/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        neo: 'var(--neo-bg)',
      },
      boxShadow: {
        'neo-outset': '-6px -6px 12px var(--neo-shadow-light), 6px 6px 12px var(--neo-shadow-dark)',
        'neo-outset-sm': '-3px -3px 6px var(--neo-shadow-light), 3px 3px 6px var(--neo-shadow-dark)',
        'neo-inset': 'inset -6px -6px 12px var(--neo-shadow-light), inset 6px 6px 12px var(--neo-shadow-dark)',
        'neo-inset-sm': 'inset -3px -3px 6px var(--neo-shadow-light), inset 3px 3px 6px var(--neo-shadow-dark)',
      }
    },
  },
  plugins: [],
}

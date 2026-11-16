/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        theater: {
          bg: '#09090B',
          panel: '#18181B',
          border: '#27272A',
          accent: '#6366F1',
        }
      }
    },
  },
  plugins: [],
}

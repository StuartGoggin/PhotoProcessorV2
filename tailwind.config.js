/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          900: "#0f0f0f",
          800: "#1a1a1a",
          700: "#242424",
          600: "#2e2e2e",
          500: "#3a3a3a",
        },
        accent: {
          DEFAULT: "#3b82f6",
          hover: "#2563eb",
        },
      },
    },
  },
  plugins: [],
};

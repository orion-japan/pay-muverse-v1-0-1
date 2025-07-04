module.exports = {
    content: [
      "./app/**/*.{js,ts,jsx,tsx}",
      "./components/**/*.{js,ts,jsx,tsx}",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
    safelist: [
      { pattern: /bg-\[radial-gradient.*/ },
    ],
    theme: {
      extend: {},
    },
    plugins: [],
  };
  
// Stays JavaScript: Next 16.3 only resolves postcss.config.{js,mjs,json}.
// A .ts file here is silently ignored and every page ships unstyled.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;

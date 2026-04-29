export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#15202b',
        panel: '#ffffff',
        canvas: '#f8fafc',
        line: '#e2e8f0',
      },
      boxShadow: {
        soft: '0 14px 40px rgba(21, 32, 43, 0.08)',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#060a12',
          900: '#0a0e1a',
          800: '#111827',
          700: '#1a2332',
          600: '#243044',
          500: '#2d3b52',
        },
        accent: {
          red: '#e63946',
          blue: '#4cc9f0',
          green: '#06d6a0',
          yellow: '#ffd60a',
          purple: '#7b61ff',
        },
        stitch: {
          DEFAULT: '#e63946',
          light: '#ff6b7a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        glass: '0 8px 32px rgba(0, 0, 0, 0.3)',
        'glass-sm': '0 4px 16px rgba(0, 0, 0, 0.2)',
        glow: '0 0 20px rgba(76, 201, 240, 0.15)',
        'glow-green': '0 0 20px rgba(6, 214, 160, 0.15)',
        'glow-red': '0 0 20px rgba(230, 57, 70, 0.15)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        shimmer: 'shimmer 2s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};

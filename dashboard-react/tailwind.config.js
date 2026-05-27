/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#111111',
        paper: '#fffdf3',
        cream: '#fff4cf',
        line: '#111111',
        navy: {
          950: '#fff4cf',
          900: '#fff8df',
          800: '#fffdf3',
          700: '#ffe89a',
          600: '#ffd84d',
          500: '#111111',
        },
        accent: {
          red: '#ff5a5f',
          blue: '#5da9ff',
          green: '#63d471',
          yellow: '#ffd84d',
          purple: '#9b5de5',
        },
        stitch: {
          DEFAULT: '#ff5a5f',
          light: '#ff8b8f',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderWidth: {
        3: '3px',
      },
      boxShadow: {
        neo: '4px 4px 0 #111111',
        'neo-lg': '7px 7px 0 #111111',
        'neo-sm': '2px 2px 0 #111111',
        glass: '4px 4px 0 #111111',
        'glass-sm': '2px 2px 0 #111111',
        glow: '4px 4px 0 #111111',
        'glow-green': '4px 4px 0 #111111',
        'glow-red': '4px 4px 0 #111111',
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

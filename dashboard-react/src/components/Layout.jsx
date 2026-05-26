import Navbar from './Navbar.jsx';
import { Footer } from './Footer.jsx';

export default function Layout({ children, activeTab, onTabChange, onRefresh, date, onDateChange }) {
  return (
    <div className="min-h-screen bg-navy-950">
      <Navbar
        activeTab={activeTab}
        onTabChange={onTabChange}
        onRefresh={onRefresh}
        date={date}
        onDateChange={onDateChange}
      />
      <main className="mx-auto max-w-[1600px] px-4 py-6">
        {children}
      </main>
      <Footer />
    </div>
  );
}

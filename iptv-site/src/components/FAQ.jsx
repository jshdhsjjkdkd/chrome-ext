import { useState } from 'react';

const faqs = [
  {
    q: 'What devices are compatible with StreamPro IPTV?',
    a: 'StreamPro works on virtually any device — Smart TVs (Samsung, LG, Sony), Amazon Firestick, Android TV boxes, Android & iOS smartphones/tablets, Windows & Mac computers, MAG boxes, and more. If it has a screen and an internet connection, chances are it works.',
  },
  {
    q: 'How do I activate my subscription after payment?',
    a: 'Activation is simple and fast! After you subscribe via WhatsApp, our team will send you your login credentials (M3U URL or Xtream Codes) within minutes. We\'ll also guide you through setup if needed — all via WhatsApp.',
  },
  {
    q: 'What internet speed do I need for streaming?',
    a: 'For HD (1080p) streaming, we recommend at least 10 Mbps. For 4K Ultra HD, we recommend 25 Mbps or higher. A stable connection is more important than raw speed — we recommend a wired ethernet connection for the best experience.',
  },
  {
    q: 'Do you offer a free trial before I subscribe?',
    a: 'Yes! We offer a 24-hour free trial so you can test the quality and channel availability before committing to a plan. Just message us on WhatsApp and we\'ll set you up with a trial account right away.',
  },
  {
    q: 'Can I watch international channels and sports events?',
    a: 'Absolutely! StreamPro includes channels from 50+ countries including USA, UK, Canada, Europe, Middle East, Latin America, and Asia. We also carry major sports packages including NFL, NBA, UFC, Premier League, La Liga, and all major PPV events.',
  },
  {
    q: 'What happens if I experience buffering or a channel is down?',
    a: 'Our 24/7 support team is always on standby via WhatsApp. Most issues are resolved within minutes. We also maintain backup server lines, so in the rare case of downtime, we can switch you instantly with no interruption to your service.',
  },
];

function FAQItem({ faq, index }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`border rounded-xl overflow-hidden transition-all duration-300 ${
        open ? 'border-indigo-500/40 bg-indigo-950/20' : 'border-white/10 bg-white/[0.02]'
      }`}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left gap-4"
      >
        <span className={`font-medium text-sm sm:text-base transition-colors ${open ? 'text-white' : 'text-gray-300'}`}>
          {faq.q}
        </span>
        <div
          className={`flex-shrink-0 w-6 h-6 rounded-full border flex items-center justify-center transition-all duration-300 ${
            open ? 'border-indigo-400 bg-indigo-500/20 rotate-45' : 'border-white/20'
          }`}
        >
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="px-5 pb-5">
          <p className="text-gray-400 text-sm leading-relaxed">{faq.a}</p>
        </div>
      )}
    </div>
  );
}

export default function FAQ() {
  return (
    <section id="faq" className="py-24 bg-[#0f0f0f] relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent" />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-4 py-1.5 mb-4 text-sm text-indigo-300">
            Got Questions?
          </div>
          <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">
            Frequently Asked{' '}
            <span className="gradient-text">Questions</span>
          </h2>
          <p className="text-gray-400 text-lg">
            Can't find what you're looking for? Ask us directly on WhatsApp.
          </p>
        </div>

        {/* FAQ list */}
        <div className="space-y-3">
          {faqs.map((faq, i) => (
            <FAQItem key={i} faq={faq} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

const WHATSAPP_NUMBER = '1234567890';

const plans = [
  {
    name: 'Basic',
    price: '9.99',
    period: '/month',
    description: 'Perfect for individuals who want to get started.',
    channels: '5,000+',
    popular: false,
    color: 'from-blue-600 to-indigo-600',
    features: [
      '5,000+ Live Channels',
      'Full HD (1080p) Quality',
      '1 Screen at a Time',
      'VOD Library Access',
      '7-Day EPG Guide',
      'Email Support',
    ],
    missing: ['4K Ultra HD', 'Multi-screen', 'Priority Support'],
  },
  {
    name: 'Standard',
    price: '19.99',
    period: '/month',
    description: 'Great for families who want more variety.',
    channels: '10,000+',
    popular: true,
    color: 'from-indigo-600 to-purple-600',
    features: [
      '10,000+ Live Channels',
      '4K Ultra HD Quality',
      '3 Screens at a Time',
      'Full VOD Library',
      '14-Day EPG Guide',
      'WhatsApp Support',
      'Sports & PPV Channels',
    ],
    missing: ['Dedicated Server', 'VIP Support'],
  },
  {
    name: 'Premium',
    price: '29.99',
    period: '/month',
    description: 'Ultimate experience for the power streamer.',
    channels: '15,000+',
    popular: false,
    color: 'from-purple-600 to-pink-600',
    features: [
      '15,000+ Live Channels',
      '4K Ultra HD + HDR',
      '5 Screens at a Time',
      'Full VOD Library',
      '30-Day EPG Guide',
      '24/7 Priority Support',
      'Sports, PPV & Adult',
      'Dedicated VIP Server',
    ],
    missing: [],
  },
];

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="w-4 h-4 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

export default function Pricing() {
  const buildWaLink = (plan) => {
    const msg = `Hello! I'm interested in the ${plan.name} IPTV Plan ($${plan.price}/month). Please help me get started.`;
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
  };

  return (
    <section id="pricing" className="py-24 bg-[#0a0a0a] relative overflow-hidden">
      {/* Background decorations */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-px bg-gradient-to-r from-transparent via-purple-500/50 to-transparent" />
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/2 left-0 w-72 h-72 bg-indigo-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 right-0 w-72 h-72 bg-purple-600/10 rounded-full blur-3xl" />
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-purple-500/10 border border-purple-500/20 rounded-full px-4 py-1.5 mb-4 text-sm text-purple-300">
            Simple, Transparent Pricing
          </div>
          <h2 className="text-4xl sm:text-5xl font-extrabold text-white tracking-tight mb-4">
            Choose Your{' '}
            <span className="gradient-text">Perfect Plan</span>
          </h2>
          <p className="text-gray-400 text-lg max-w-xl mx-auto">
            No hidden fees. No contracts. Cancel anytime. Start streaming in minutes via WhatsApp.
          </p>
        </div>

        {/* Plan cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`relative flex flex-col rounded-2xl transition-all duration-300 card-hover ${
                plan.popular
                  ? 'bg-gradient-to-b from-indigo-950/80 to-purple-950/80 border-2 border-indigo-500/60 glow-blue scale-105'
                  : 'bg-white/[0.03] border border-white/10 hover:border-white/20'
              }`}
            >
              {/* Popular badge */}
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white text-xs font-bold px-4 py-1.5 rounded-full shadow-lg">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    Most Popular
                  </span>
                </div>
              )}

              <div className="p-7 flex flex-col flex-1">
                {/* Plan header */}
                <div className={`inline-flex self-start px-3 py-1 rounded-lg bg-gradient-to-r ${plan.color} text-white text-sm font-semibold mb-4`}>
                  {plan.name}
                </div>

                <p className="text-gray-400 text-sm mb-6">{plan.description}</p>

                {/* Price */}
                <div className="mb-6">
                  <div className="flex items-end gap-1">
                    <span className="text-gray-400 text-lg">$</span>
                    <span className="text-5xl font-extrabold text-white">{plan.price}</span>
                    <span className="text-gray-400 text-sm mb-1">{plan.period}</span>
                  </div>
                  <p className="text-gray-500 text-xs mt-1">{plan.channels} live channels</p>
                </div>

                {/* Features */}
                <ul className="space-y-3 flex-1 mb-8">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm text-gray-300">
                      <CheckIcon />
                      {f}
                    </li>
                  ))}
                  {plan.missing.map((f) => (
                    <li key={f} className="flex items-center gap-3 text-sm text-gray-600">
                      <XIcon />
                      {f}
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <a
                  href={buildWaLink(plan)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`w-full flex items-center justify-center gap-2 font-semibold py-3.5 rounded-xl transition-all duration-200 text-sm ${
                    plan.popular
                      ? 'bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white hover:shadow-lg hover:shadow-indigo-500/30'
                      : 'bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white'
                  }`}
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                  Subscribe via WhatsApp
                </a>
              </div>
            </div>
          ))}
        </div>

        {/* Trust badges */}
        <div className="mt-14 flex flex-wrap justify-center gap-6 text-gray-500 text-sm">
          {[
            { icon: '🔒', text: 'Secure & Private' },
            { icon: '✅', text: 'No Contract Required' },
            { icon: '⚡', text: 'Instant Activation' },
            { icon: '💬', text: 'WhatsApp Support' },
          ].map((badge) => (
            <div key={badge.text} className="flex items-center gap-2">
              <span>{badge.icon}</span>
              <span>{badge.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseOrigin = supabaseUrl ? new URL(supabaseUrl).origin : '';
const securityHeaders = [
  {key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"},
  {key: 'X-Frame-Options', value: 'DENY'},
  {key: 'X-Content-Type-Options', value: 'nosniff'},
  {key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin'},
];

if (process.env.NODE_ENV === 'production') {
  securityHeaders.push({
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      ["connect-src 'self'", supabaseOrigin].filter(Boolean).join(' '),
      "frame-ancestors 'none'",
    ].join('; '),
  });
}

export default {
  async headers() {
    return [{source: '/:path*', headers: securityHeaders}];
  },
};

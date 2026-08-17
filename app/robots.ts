import type { MetadataRoute } from 'next';

// Disallowed, not allowed - this is a live paper-trading dashboard, not a
// marketing site, and every crawler request is a real Vercel function
// invocation against Turso that counts toward the monthly usage budget.
// Cost-conscious per the user's explicit ask to trim Vercel spend.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  };
}

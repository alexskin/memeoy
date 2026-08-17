import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'Memeoy - AI-watched Solana memecoin trading bot';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#06080c',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ fontSize: 120, fontWeight: 700, color: '#eab308', letterSpacing: -2 }}>Memeoy</div>
        <div style={{ fontSize: 34, color: '#7c879a', marginTop: 20 }}>
          AI-watched Solana memecoin trading bot
        </div>
        <div style={{ fontSize: 24, color: '#4b5563', marginTop: 16 }}>
          Paper mode by default · real market data · opt-in live trading
        </div>
      </div>
    ),
    { ...size },
  );
}

'use client';
import { useState } from 'react';

export function CopyableCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <span
      style={{ fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer', color: copied ? 'var(--pos, #4ade80)' : undefined }}
      title="Click to copy"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied! ✓' : address}
    </span>
  );
}

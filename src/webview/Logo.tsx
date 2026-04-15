export function Logo() {
  return (
    <svg
      class="empty-state-logo"
      viewBox="0 0 680 320"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Left angle bracket */}
      <polygon
        points="298,125 260,152 298,179 298,170 271,152 298,134"
        class="logo-bracket"
      />
      {/* Right angle bracket */}
      <polygon
        points="382,125 420,152 382,179 382,170 409,152 382,134"
        class="logo-bracket"
      />
      {/* Lightning bolt */}
      <path
        transform="translate(286,98) scale(4.5)"
        d="M14.5 2L5 13h6.5L9.5 22L19 11h-6.5L14.5 2Z"
        class="logo-bolt"
      />
      {/* Wordmark */}
      <text x="340" y="255" class="logo-text">
        Code<tspan class="logo-text-accent">Spark</tspan>
      </text>
    </svg>
  );
}

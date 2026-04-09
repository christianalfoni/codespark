export function Logo() {
  return (
    <svg
      class="empty-state-logo"
      viewBox="0 0 680 320"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Left angle bracket */}
      <polygon
        points="290,80 276,80 232,152 276,224 290,224 246,152"
        class="logo-bracket"
      />
      {/* Right angle bracket */}
      <polygon
        points="390,80 404,80 448,152 404,224 390,224 434,152"
        class="logo-bracket"
      />
      {/* Lightning bolt */}
      <path
        transform="translate(286,98) scale(4.5)"
        d="M14.5 2L5 13h6.5L9.5 22L19 11h-6.5L14.5 2Z"
        class="logo-bolt"
      />
      {/* Wordmark */}
      <text x="340" y="295" class="logo-text">
        Code<tspan class="logo-text-accent">Spark</tspan>
      </text>
    </svg>
  );
}

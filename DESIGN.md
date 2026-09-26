# ColdDrop design

Rim reviews footage at a desk in daylight and checks uploads on a phone; white surfaces keep filenames legible and let media carry the screen.

Restrained palette. Primary oklch(0.476 0.158 268.5), background oklch(1 0 0), surface oklch(0.965 0.005 268), ink oklch(0.22 0.018 268), muted oklch(0.49 0.02 268), success oklch(0.38 0.1 155). System sans with fixed type sizes. Indigo is reserved for selected navigation and primary actions. Media tiles are justified by the gallery workflow; other UI uses flat sections and separators.

Windows keeps the sidebar layout. Android uses its own phone shell: 56px app bar that turns into a selection bar, sticky filter chips, a square thumbnail grid sized with clamp so small phones get three columns and tablets more, bottom sheets for every menu, a floating add button, and a bottom tab bar with a pill indicator that becomes a side rail from 840px. Every tab stays mounted and fades in over 200ms, keeping its scroll position. Deletes are instant with a five second undo toast. Controls are at least 44px. Motion uses 150 to 300ms ease-out transitions and respects reduced motion.

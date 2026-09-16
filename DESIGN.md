# Corporate championship visual direction

The public site is a full visual overhaul for company captains and colleagues: welcoming corporate event branding with playful sports interactions. Native CSS and the existing JavaScript frontend retain the API, registration routes and event facts.

Design variance 6, motion intensity 5, visual density 3. The previous condensed uppercase, red-and-black poster layout is replaced by self-hosted Barlow, white, rich red and golden yellow, generous spacing, and rounded shapes. Cards use 20-24px radii; interactive controls use pill shapes. The requested white, red and yellow theme remains consistent regardless of system color preference.

The hero introduces the event and registration. Sport cards link to the existing registration route. Team tabs retain live API data and now support arrow, Home, and End keys. Date and venue information use the supplied event facts. No invented pricing, sponsors, or attendance claims.

Motion: one-shot hero entrance, IntersectionObserver section reveals, hover lift and sports-symbol bounce, button press feedback, FAQ entrance. Reduced motion disables all animations and smooth scrolling. Mobile sections explicitly collapse to one column.

## Generated asset

Built-in image generation produced `public/images/team-spirit-red.webp` (compressed from the edited PNG). The original is retained in the local image-generation output folder.

Prompt: Create a premium editorial illustration for a corporate sports championship website. Landscape 3:2 composition. A playful sophisticated 3D clay and paper illustration of a diverse group of six adult South Asian office colleagues now in sports uniforms, enjoying a mini sports park: one playing football, one holding cricket bat, one throwing basketball, others cheering and high fiving. Minimal sculptural forms, friendly proportionate adult characters, forest green uniforms with off-white and muted golden yellow accents, warm cream background, soft ambient sunlight, architectural miniature green courts and white court markings. Large floating football and little basketball as part of composition. Modern high-end brand illustration, tactile matte materials, charming but professional for corporate audience. No text, no typography, no logos. Balanced composition, fill frame, clean warm off-white background.

Palette update: the built-in image tool recolored the original illustration. Edit prompt: preserve the people, composition, expressions and framing; change uniforms and caps to rich warm red with golden yellow and white accents, the backboard to red, and the court to terracotta with white lines. Keep natural skin tones and trees, with a bright warm white background. No text or logos.

The venue includes a lazy-loaded Google Maps iframe using the exact place identifier from the organizer’s supplied link, with a standalone directions link as a fallback.

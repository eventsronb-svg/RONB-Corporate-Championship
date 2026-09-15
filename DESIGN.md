# RONB Corporate Championship: public website

## Direction

Swiss industrial sports print. A corporate captain browses the event on a phone in daylight or at their office desk. The light paper canvas gives the event poster clarity in both settings. The requested brutalist style is expressed through condensed typography, unrounded geometry, visible divisions and bold red accents.

## Content

October 1–4, 2026. Royal Sports Park, Chunikhel, Kathmandu. Futsal (5-a-side), Cricksul (format not yet supplied), Basketball (3v3). The organizer-provided Google Maps link is authoritative. No invented fees, prize pools, match schedule, sponsors, capacity, or registration deadlines.

## Visual system

- Paper: #f1f0e8. Ink: #171a17. Red: #df321e. Rules: #b9bab0.
- Display: locally hosted Barlow Condensed, weight 800, uppercase, tight tracking and line height. It has the compact density of sports scoreboards and tournament posters.
- Body: locally hosted Barlow, regular and semibold. Metadata: system monospace in small doses.
- Buttons: square, 48px minimum height; red primary with dark text for contrast, clear focus rings.
- Layout: wide bordered poster. Asymmetric hero, three equal sport choices for comparison, spacious venue spread, ruled FAQ rows. No shadows, gradient fills, floating cards or rounded surfaces.
- Photography: original generated monochrome futsal campaign image, illustrative of the sport and not claimed to show the venue.
- Motion: short image and title entrance, hover arrows; reduced-motion preference disables animation. Main content never starts hidden.

## Interaction

Public sport tabs load only paid, profile-complete teams from the API. Registration is a separate full page, with steps derived from order status, not browser-local progress. Form inputs have persistent labels and inline feedback. Unknown registration prices are omitted until configured in the backend. Team logos and receipts are uploaded via the existing endpoints.

## Accessibility

Semantic landmarks and heading order, visible keyboard focus, 44px+ touch targets, named controls, meaningful loading/error/empty states, live form feedback, no automatic carousel, no color-only status indicators. All content reflows on narrow screens.

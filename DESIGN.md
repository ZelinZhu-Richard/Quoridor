# Linebreak design

The approved direction is a quiet, precise tabletop game. The board leads and the surrounding interface gives just enough context to make a move.

- Warm paper background #f3f1e9, pale board cells, dark ink #242923.
- Teal #1b6b60 and rust #a64b2c, labeled A and B with different pawn shapes.
- Self-hosted IBM Plex Sans. Comfortable body text; compact button labels and tabular game numerals.
- Home: generous title and game board, compact horizontal mode choices. No sales claims or oversized cards.
- Game: slim top navigation, turn strip, square board, action rail. On narrow screens the action rail becomes a bottom control area.
- Signature interaction: a rigid two-edge wall snaps to an anchor and rotates in place. Invalid placement explains the rule. Touch requires confirmation.
- Fast 140–180ms movement transitions; reduced motion disables animation.
- Goal is always the top edge. Neither player's view rotates.
- Every control has hover, focus, loading, error and disabled states. Color never carries player identity alone.

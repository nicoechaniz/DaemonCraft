# Preemption-Tolerance Patterns for Embodied AI Agents in Minecraft

## 1. Canonical Patterns in Robotics & Game AI

### A. Subsumption Architecture (Brooks, 1986)
- **Concept:** Layered control systems where higher levels (deliberative strategy) can override lower levels (reactive survival), but lower levels can preempt higher levels when safety invariants are breached.
- **Pattern:** Inhibition and Suppression nodes. If an obstacle is detected, the L2 Reflex layer suppresses the motor commands from L3 pathfinding and substitutes its own (e.g., "stop" or "jump back").
- **Pseudocode:**
  ```python
  class MotorArbiter:
      def __init__(self):
          self.l2_cmd = None
          self.l3_cmd = None

      def update(self):
          if self.l2_cmd and self.l2_cmd.priority > THRESHOLD:
              execute(self.l2_cmd) # Preempts L3
          else:
              execute(self.l3_cmd)
  ```

### B. ROS `actionlib` Preemption Patterns
- **Concept:** Long-running goals running asynchronously that can be canceled or superseded by a new goal.
- **Pattern:** Polling for preemption requests within the execution loop (`is_preempt_requested()`), transitioning to a safe state, and explicitly setting the result to `set_preempted()`.
- **Pseudocode:**
  ```python
  def execute_cb(self, goal):
      for step in goal.steps:
          if self._action_server.is_preempt_requested():
              self.cleanup_to_safe_state()
              self._action_server.set_preempted()
              return
          execute_step(step)
  ```

### C. Behavior Trees with Guard Nodes
- **Concept:** Tree execution where evaluating nodes from left to right establishes priority.
- **Pattern:** "Active Selectors" or "Parallel Decorators" check conditions (e.g., `IsSafe()`) continuously while running an action. If the condition fails, the running node is aborted, and a recovery branch is executed.

### D. Hierarchical Task Networks (HTN) with Replanning
- **Concept:** Planning complex tasks by decomposing them into primitive actions.
- **Pattern:** When a primitive action fails or is interrupted by a dynamic event, the system invalidates the current plan and initiates local replanning from the current world state, maintaining the high-level intent.

## 2. Mineflayer-Specific Failure Modes on Interruption

- **Block Placement (`place_block`)**
  - *Failure Mode:* A network packet to place a block is sent, but the client interrupts and moves on. The server rejects the placement (e.g., due to line-of-sight), but the client predicts success, causing a "ghost block" and inventory desync.
  - *Mitigation:* Await the server's acknowledgement packet. If aborted mid-flight, forcefully resync the inventory and the local chunk block state.

- **Pathfinding (`mineflayer-pathfinder` goto/gotoNear)**
  - *Failure Mode:* The pathfinder sets continuous inputs (e.g., `bot.setControlState('forward', true)`). If the behavior is abruptly killed, the control states are never reset, causing the bot to walk blindly into hazards ("stranded control state").
  - *Mitigation:* Always use a `try...finally` block that calls `bot.clearControlStates()` when exiting the pathfinding loop.

- **Jumping / Parkour**
  - *Failure Mode:* Aborting mid-jump leaves the bot with unpredictable horizontal velocity, often leading to missing the landing, taking fall damage, or false "flying" kicks from server anti-cheat.
  - *Mitigation:* Jumps are "Atomic Ceilings". Do not abort mid-air. Wait for `bot.entity.onGround == true` before yielding control back.

- **Inventory and Crafting**
  - *Failure Mode:* Opening a chest or crafting table opens a UI window. Preempting before closing the window leads to "ghost items" or dropped items (when the crafting grid clears unexpectedly), and prevents future interactions because the server considers the window open while the bot client thinks it's closed.
  - *Mitigation:* Ensure `bot.closeWindow(window)` is always called upon preemption in a cleanup routine.

## 3. Safe Yield Points and Atomic Action Ceilings

### The Atomic Unit of Action in Mineflayer
In Mineflayer, the smallest non-divisible unit of action is dictated by the server's physics tick rate (20 TPS, or 50ms):
1. **Movement:** A single tick of physics simulation (50ms).
2. **Interaction:** A complete server round-trip (Request -> Acknowledgement).

### Implementing `onAbort()` Cleanup
Every high-level primitive should implement a cleanup phase. The "Atomic Action Ceiling" defines the non-interruptible sections (e.g., being mid-air, or waiting for a chest window to open). Yield points should only occur at the boundary of these ceilings.

```javascript
class Primitive {
  async execute(bot, cancelToken) {
    try {
      while (!cancelToken.isCancelled()) {
        // Safe Yield Point
        await bot.waitForTicks(1); 
        
        // --- Atomic Section Begin ---
        bot.setControlState('forward', true);
        if (needsJump) bot.setControlState('jump', true);
        // Do not yield if mid-air!
        // --- Atomic Section End ---
      }
    } finally {
      this.onAbort(bot);
    }
  }

  onAbort(bot) {
    // Crucial cleanup to prevent stranded states
    bot.clearControlStates();
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
    }
  }
}
```

## 4. Affordance Field Design for 2.5D Voxel Worlds

### Computing a 9x3 Affordance Field
- **Concept:** Evaluates the immediate surrounding (8 horizontal compass directions + staying still) at up to 3 blocks distance.
- **Algorithm:** Use local raycasting or chunk matrix analysis. Assign positive weights to coordinates moving "away from threat" (maximizing distance vector) and negative weights to hazards (lava, cliffs, solid walls). Select the highest-scoring vector.

### Flee Direction Selection & Baritone Escape Routing
- **Baritone Algorithm:** Baritone uses a modified A* algorithm with segmented calculation and incremental cost backoff. If it can't find a complete path out, it selects the best partial segment.
- **The `#invert` Strategy:** For escape routing, setting a goal at the danger source and running an `#invert` pathing command forces the bot to find the cheapest path maximizing distance from the danger zone.
- **Cost Heuristics:** The A* cost function heavily penalizes slow actions (breaking obsidian) and dangerous moves (falling without water, walking near fire), allowing for swift and safe evasion.

## 5. Audit Checklist for SOUL Templates (Preemption Tolerance)

When writing or reviewing L3 Gemma-Andy scripts (SOUL templates), verify the following for preemption safety:

- [ ] **Idempotency:** Are sub-tasks idempotent? If `GatherWood` is interrupted after breaking 2 blocks, running it again should seamlessly resume gathering the remainder without failing.
- [ ] **State Restoration:** Do scripts handle being restarted from an arbitrary point? (e.g., checking if the sword is already equipped instead of blindly sending equip commands).
- [ ] **Cleanup Hooks:** Does the task clean up its temporary state (chests explicitly closed, control states explicitly cleared) if preempted?
- [ ] **Atomic Sections:** Are critical sections (like the 3 steps of crafting: open, shift-click, close) protected from interruption, or cleanly recoverable if interrupted?
- [ ] **Yielding:** Do long `while` or `for` loops explicitly yield or check a cancellation token to allow the L2 Reflex Runner to step in?

## References
- Brooks, R. A. (1986). A robust layered control system for a mobile robot. *IEEE Journal on Robotics and Automation*, 2(1), 14-23.
- ROS `actionlib` documentation (http://wiki.ros.org/actionlib)
- Baritone Pathfinding Bot Repository (https://github.com/cabaletta/baritone)
- Mineflayer API documentation (Control States, Inventory Management, physics engine limitations).
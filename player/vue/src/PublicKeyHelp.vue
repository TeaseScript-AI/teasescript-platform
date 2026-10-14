<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";

// How a public key opener works (docs/ENCRYPTION.md), for a player who never heard of age or SSH: collapsed under the
// public key field of the lock dialog and the unlock request of the unlock dialog.
</script>

<template>
  <Collapsible>
    <CollapsibleTrigger as-child>
      <Button variant="ghost" class="min-h-11 justify-self-start" data-public-key-help>
        How does this work?
        <ChevronDown aria-hidden="true" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="grid gap-2 pb-2 text-sm text-muted-foreground" data-public-key-help-text>
        <p>
          A public key belongs to a private key that its owner keeps secret. The public key only
          locks, and only its private key opens.
        </p>
        <p>Such keys come from age (age-keygen) or SSH (ssh-keygen -t ed25519).</p>
        <p>To open it, the owner of the private key runs this on the unlock request:</p>
        <code class="block break-all rounded-md bg-muted px-2 py-1 font-mono text-foreground"
          >age -d -i &lt;private key file&gt; unlock-request.age</code
        >
        <p>and sends back the unlock key it shows.</p>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>

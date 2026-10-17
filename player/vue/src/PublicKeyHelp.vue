<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import Collapsible from "@/components/ui/collapsible/Collapsible.vue";
import CollapsibleContent from "@/components/ui/collapsible/CollapsibleContent.vue";
import CollapsibleTrigger from "@/components/ui/collapsible/CollapsibleTrigger.vue";

// What a public key is, for a player who never used a terminal: collapsed under the public key field of the lock dialog.
// The commands for the owner of the private key are in docs/ENCRYPTION.md, never in the Player.
defineProps<{
  /** The other openers the dialog offers, such as "a time" and "a password"; none leaves their line out. */
  others: readonly string[];
}>();
</script>

<template>
  <Collapsible>
    <CollapsibleTrigger as-child>
      <Button variant="ghost" class="min-h-11 justify-self-start" data-public-key-help>
        What is a public key?
        <ChevronDown aria-hidden="true" />
      </Button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="grid gap-2 pb-2 text-sm text-muted-foreground" data-public-key-help-text>
        <p>
          A public key is a code you get from someone else, for example the person who decides when
          this opens. Paste it here. Only that person can open it again, with their own private key.
        </p>
        <p v-if="others.length > 0">No public key? Use {{ others.join(" or ") }} instead.</p>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>

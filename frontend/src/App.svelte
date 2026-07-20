<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { onMount } from "svelte";
  import ConvertForm from "./components/ConvertForm.svelte";
  import CurrentJob from "./components/CurrentJob.svelte";
  import Header from "./components/Header.svelte";
  import History from "./components/History.svelte";
  import PreviewDialog from "./components/PreviewDialog.svelte";
  import { refreshStale } from "./lib/convert.svelte";

  onMount(() => {
    void refreshStale();
  });
</script>

<main>
  <Header />
  <ConvertForm />
  <CurrentJob />
  <History />
</main>
<PreviewDialog />

<style>
  main { max-width: 44rem; margin: 0 auto; padding: 28px 20px 48px; }
</style>

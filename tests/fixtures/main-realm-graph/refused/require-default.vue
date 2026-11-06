<script>
// The default sees the global `require`: the body's function is not in scope for the parameters.
export function load(id = require("./sibling.js")) {
  function require(value) {
    return value;
  }
  return require(id);
}
</script>

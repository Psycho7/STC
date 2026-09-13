// Code flags: constants the whole program reads to pick between two shipped
// behaviours. A leaf module on purpose -- it imports nothing, so any layer can
// read a flag without pulling a dependency along.

// ON: a catalyst row draws an edge from the item's boundary input node
// (`u:in:<item>` -> the card's `cat:<item>` port), and that node's rate counts
// the cycled draw alongside ordinary consumption.
// OFF: catalyst rows carry no port and no edge, the boundary node's rate
// excludes the draw, and the inputs panel adds the solver's catalystDraw onto
// the supply row itself.
export const CATALYST_SUPPLY_EDGES = true;

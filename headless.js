const board=window.miro?.board;
if(board?.ui) {
  // Intentionally zero SDK operations here, even with 20 guests moving cards.
  // The manager only runs after a deliberate button click inside the panel.
  board.ui.on('icon:click',async()=>board.ui.openPanel({url:'panel.html?v=1.9.2'}));
}

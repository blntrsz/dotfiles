return {
  "kamykn/spelunker.vim",
  config = function()
    vim.cmd("highlight SpelunkerSpellBad cterm=undercurl gui=undercurl guisp=NONE guifg=NONE")
    vim.cmd(
      "highlight SpelunkerComplexOrCompoundWord cterm=undercurl ctermfg=NONE gui=undercurl guifg=NONE guisp=NONE"
    )
  end,
}

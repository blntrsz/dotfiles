-- Formatter name -> Mason package name (nil = not available via Mason, install manually)
local mason_packages = {
  stylua = "stylua",
  biome = "biome",
  prettierd = "prettierd",
  oxfmt = nil,
}

local formatters_by_ft = {
  astro = { "oxfmt", "biome", "prettierd", stop_after_first = true },
  javascript = { "oxfmt", "biome", "prettierd", stop_after_first = true },
  typescript = { "oxfmt", "biome", "prettierd", stop_after_first = true },
  typescriptreact = { "oxfmt", "biome", "prettierd", stop_after_first = true },
  svelte = { "oxfmt", "prettierd", stop_after_first = true },
  lua = { "stylua" },
}

-- Conditionally ensure formatters exist: only installs via Mason when the
-- binary is missing and a relevant file type is opened.
local function ensure_formatter(name)
  if mason_packages[name] == nil or vim.fn.executable(name) == 1 then
    return
  end

  local ok, registry = pcall(require, "mason-registry")
  if not ok then
    return
  end

  local pkg_name = mason_packages[name]
  local has_package = type(registry.has_package) == "function" and registry.has_package(pkg_name)
  local is_installed = type(registry.is_installed) == "function" and registry.is_installed(pkg_name)
  if not has_package or is_installed then
    return
  end

  local ok_pkg, pkg = pcall(registry.get_package, pkg_name)
  if not ok_pkg then
    return
  end

  vim.notify("Installing formatter via Mason: " .. pkg_name, vim.log.levels.INFO)
  pcall(function()
    pkg:install()
  end)
end

local ensure_group = vim.api.nvim_create_augroup("user-ensure-formatters", { clear = true })
vim.api.nvim_create_autocmd("FileType", {
  group = ensure_group,
  pattern = vim.tbl_keys(formatters_by_ft),
  callback = function(args)
    for _, formatter in ipairs(formatters_by_ft[args.match] or {}) do
      ensure_formatter(formatter)
    end
  end,
})

vim.api.nvim_create_user_command("ConformDisable", function(args)
  if args.bang then
    -- FormatDisable! will disable formatting just for this buffer
    vim.b.disable_autoformat = true
  else
    vim.g.disable_autoformat = true
  end
end, {
  desc = "Disable conform-autoformat-on-save",
  bang = true,
})

vim.api.nvim_create_user_command("ConformEnable", function()
  vim.b.disable_autoformat = false
  vim.g.disable_autoformat = false
end, {
  desc = "Re-enable conform-autoformat-on-save",
})

return {
  {
    "stevearc/conform.nvim",
    event = { "BufWritePre" },
    cmd = { "ConformInfo" },
    opts = {
      notify_on_error = false,
      default_format_opts = {
        async = true,
        timeout_ms = 500,
        lsp_format = "fallback",
      },
      format_after_save = function(buffer_number)
        if vim.g.disable_autoformat or vim.b[buffer_number].disable_autoformat then
          return
        end
        return {
          async = true,
          timeout_ms = 500,
          lsp_format = "fallback",
        }
      end,
      formatters_by_ft = formatters_by_ft,
      formatters = {
        oxfmt = {
          condition = function(_, ctx)
            return vim.fs.find({ ".oxfmtrc.json", ".oxfmtrc.jsonc" }, {
              path = ctx.filename,
              upward = true,
              stop = vim.uv.os_homedir(),
            })[1] ~= nil
          end,
        },
        biome = {
          condition = function(_, ctx)
            return vim.fs.find({ "biome.json", "biome.jsonc" }, {
              path = ctx.filename,
              upward = true,
              stop = vim.uv.os_homedir(),
            })[1] ~= nil
          end,
        },
        prettierd = {
          condition = function(_, ctx)
            return vim.fs.find({
              ".prettierrc",
              ".prettierrc.json",
              ".prettierrc.js",
              ".prettierrc.cjs",
              ".prettierrc.mjs",
              "prettier.config.js",
              "prettier.config.cjs",
              "prettier.config.mjs",
            }, {
              path = ctx.filename,
              upward = true,
              stop = vim.uv.os_homedir(),
            })[1] ~= nil
          end,
        },
      },
    },
  },
}

import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    'getting-started',
    {
      type: 'category',
      label: 'Using the web UI',
      collapsed: false,
      items: ['guide/library', 'guide/filters', 'guide/lightbox', 'guide/tags', 'guide/admin', 'guide/phone'],
    },
    'catalogs',
    'models',
    'cli',
    {
      type: 'category',
      label: 'How it works',
      items: ['internals/overview', 'internals/search', 'internals/subject-tagging', 'internals/manual-tags', 'internals/data-layout'],
    },
    'api',
    'development',
    'limitations',
  ],
};

export default sidebars;
